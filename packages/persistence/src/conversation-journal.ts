import { createToolError } from '@aftersales/contracts'
import { DomainError, redactDeep, redactText } from '@aftersales/domain'
import type { P6ConfigSnapshot, P6Task } from '@aftersales/contracts'
import type { SqliteDatabase } from './db.js'
import type { P6TaskRepository } from './p6-task-repository.js'
import { P6ConversationRefundRepository } from './p6-conversation-refund.js'

/**
 * 会话受理与确认事件共用任务数据库 只在同步事务内写入
 * 请求幂等键绑定客户与原始消息 回复绑定原补问而不是恢复时重新猜测
 */
export class ConversationJournal {
  constructor(
    readonly db: SqliteDatabase,
    readonly tasks: P6TaskRepository,
  ) {}

  /** 为当前会话追加脱敏事件 原子业务路径应在调用方事务内使用 */
  append(runId: string, type: string, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO agent_events (run_id, sequence, type, payload_json, created_at)
      SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ? FROM agent_events WHERE run_id = ?`,
      )
      .run(runId, type, JSON.stringify(redactDeep(payload)), new Date().toISOString(), runId)
  }

  /** 区分新会话 原补问和原售后补充 原请求重放不产生第二条消息 */
  accept(
    customerId: string,
    requestKey: string,
    message: string,
    config: P6ConfigSnapshot,
    runId?: string,
    returnShipment?: { returnNo: string; trackingNo: string },
  ): P6Task {
    if (!requestKey.trim() || requestKey.length > 200 || !message.trim() || message.length > 4000) {
      throw new DomainError(createToolError('VALIDATION_ERROR', '请求键或消息不合法'))
    }
    return this.db
      .transaction(() => {
        // 原始操作内容用于重放比较 脱敏展示另行处理
        const payload = {
          message,
          runId: runId ?? null,
          ...(returnShipment ? { returnShipment } : {}),
          ...(!runId && config.value.mode === 'live' ? { modelMode: 'live' } : {}),
        }
        const existing = this.tasks.findRequest(customerId, requestKey)
        if (existing) {
          // 同键冲突必须在写入前报错 不静默复用另一条消息
          if (JSON.stringify(existing.input.requestPayload) !== JSON.stringify(payload)) {
            throw new DomainError(createToolError('CONFLICT', '请求键已用于不同消息'))
          }
          return existing
        }
        // 新会话采用当前配置 继续原会话时改用已保存配置
        let frozen = config
        let replyToToolCallId: string | undefined
        if (runId) {
          const run = this.db
            .prepare('SELECT customer_id AS customerId, status FROM agent_runs WHERE run_id = ?')
            .get(runId) as { customerId: string; status: string } | undefined
          if (!run || run.customerId !== customerId)
            throw new DomainError(createToolError('AUTHORIZATION_DENIED', '无权访问该会话'))
          // 已建售后的补充优先走原业务 不把寄回消息变成新退款意图
          const refunds = new P6ConversationRefundRepository(this.db)
          const link = refunds.link(runId)
          if (link) {
            if (link.projected || !['awaiting_input', 'awaiting_approval'].includes(run.status))
              throw new DomainError(createToolError('CONFLICT', '原售后流程当前不接受补充'))
            try {
              const { origin } = refunds.validate(link)
              // 运单登记与补充命令共享事务 任一步失败都不留下半次受理
              if (returnShipment)
                refunds.shipment(
                  runId,
                  customerId,
                  returnShipment.returnNo,
                  returnShipment.trackingNo,
                )
              // 沿用原申请配置与关联 后来的设置变化不能改写原授权
              const note = this.tasks.accept({
                customerId,
                requestKey,
                kind: 'message',
                runId,
                config: origin.input.config,
                requestPayload: payload,
                plan: { input: redactText(message), tool: 'conversation' },
              })
              // 原动作尚未返回结果 补充只落库 不制造配对或重启模型规划
              this.db
                .prepare(
                  "UPDATE p6_tasks SET status = 'completed' WHERE task_id = ? AND status = 'queued'",
                )
                .run(note.taskId)
              this.db
                .prepare(
                  "INSERT INTO p6_events(task_id,event_key,payload_json) VALUES (?,'status:completed',?)",
                )
                .run(
                  note.taskId,
                  JSON.stringify({
                    status: 'completed',
                    returnNo: link.return_no,
                    businessToolCallId: link.tool_call_id,
                  }),
                )
              this.append(runId, 'message.user', {
                text: redactText(message),
                requestKey,
                returnNo: link.return_no,
                businessToolCallId: link.tool_call_id,
              })
              return this.tasks.get(note.taskId)!
            } catch (error) {
              throw new DomainError(
                createToolError(
                  'CONFLICT',
                  error instanceof Error ? error.message : '原售后关联校验失败',
                ),
              )
            }
          }
          if (returnShipment)
            throw new DomainError(createToolError('CONFLICT', '会话没有可登记寄回的原售后流程'))
          // 没有原售后时才按普通补问继续 必须确实处于等待输入
          if (run.status !== 'awaiting_input')
            throw new DomainError(createToolError('CONFLICT', '会话不在等待补充信息'))
          if (
            this.db
              .prepare(
                "SELECT 1 FROM p6_tasks WHERE run_id = ? AND status IN ('queued', 'running', 'needs_confirmation')",
              )
              .get(runId)
          ) {
            throw new DomainError(createToolError('CONFLICT', '会话已有未完成命令'))
          }
          const original = this.db
            .prepare(
              'SELECT input_json AS input FROM p6_commands WHERE run_id = ? ORDER BY rowid LIMIT 1',
            )
            .get(runId) as { input: string } | undefined
          if (!original)
            throw new DomainError(createToolError('CONFLICT', '旧会话不能自动迁移到持久执行'))
          frozen = (JSON.parse(original.input) as { config: P6ConfigSnapshot }).config
          // 从最近暂停事件找原问题标识 不根据回复文字猜配对
          const pause = this.db
            .prepare(
              "SELECT payload_json AS payload FROM agent_events WHERE run_id = ? AND type = 'run.paused' ORDER BY sequence DESC LIMIT 1",
            )
            .get(runId) as { payload: string } | undefined
          replyToToolCallId = pause
            ? (JSON.parse(pause.payload) as { toolCallId?: string }).toolCallId
            : undefined
        }
        // 命令 任务 会话状态与客户事件在同一事务提交
        const task = this.tasks.accept({
          customerId,
          requestKey,
          kind: runId ? 'message' : 'start',
          runId,
          config: frozen,
          requestPayload: payload,
          source: 'sim',
          plan: { input: redactText(message), tool: 'conversation' },
        })
        this.db
          .prepare("UPDATE agent_runs SET status = 'running', updated_at = ? WHERE run_id = ?")
          .run(new Date().toISOString(), task.runId)
        this.append(
          task.runId,
          runId ? 'run.resumed' : 'run.started',
          runId
            ? { resumePoint: 'user_message' }
            : { customerId, model: frozen.model, promptVersion: frozen.promptVersion },
        )
        this.append(task.runId, 'message.user', {
          text: redactText(message),
          // 与受理事务共享请求键 前端仅确认这一条提交而非相同文本
          requestKey,
          ...(replyToToolCallId ? { replyToToolCallId } : {}),
        })
        return task
      })
      .immediate()
  }

  /** 按会话序号恢复上下文 此方法不承担面向客户的字段白名单 */
  events(runId: string): Array<{ type: string; payload: unknown }> {
    const rows = this.db
      .prepare(
        'SELECT type, payload_json AS payload FROM agent_events WHERE run_id = ? ORDER BY sequence',
      )
      .all(runId) as Array<{ type: string; payload: string }>
    return rows.map((row) => ({ type: row.type, payload: JSON.parse(row.payload) }))
  }

  /** 客户控制命令同事务受理和完成 不交给模型或资金 Worker */
  control(
    customerId: string,
    requestKey: string,
    action: 'human' | 'end_consultation',
    config: P6ConfigSnapshot,
    sourceRunId?: string,
  ): P6Task {
    if (!requestKey.trim() || requestKey.length > 200)
      throw new DomainError(createToolError('VALIDATION_ERROR', '请求键不合法'))
    return this.db
      .transaction(() => {
        const payload = { action, sourceRunId: sourceRunId ?? null }
        const existing = this.tasks.findRequest(customerId, requestKey)
        if (existing) {
          if (JSON.stringify(existing.input.requestPayload) !== JSON.stringify(payload))
            throw new DomainError(createToolError('CONFLICT', '请求键已用于不同操作'))
          return existing
        }
        const source = sourceRunId
          ? (this.db
              .prepare('SELECT customer_id AS customerId, status FROM agent_runs WHERE run_id = ?')
              .get(sourceRunId) as { customerId: string; status: string } | undefined)
          : undefined
        if (sourceRunId && source?.customerId !== customerId)
          throw new DomainError(createToolError('AUTHORIZATION_DENIED', '无权访问该会话'))
        const busy =
          sourceRunId &&
          this.db
            .prepare(
              "SELECT 1 FROM p6_tasks WHERE run_id = ? AND status IN ('queued','running','needs_confirmation')",
            )
            .get(sourceRunId)
        const refund = sourceRunId && new P6ConversationRefundRepository(this.db).link(sourceRunId)
        const original = sourceRunId
          ? (this.db
              .prepare(
                'SELECT input_json AS input FROM p6_commands WHERE run_id = ? ORDER BY rowid LIMIT 1',
              )
              .get(sourceRunId) as { input: string } | undefined)
          : undefined
        const originalConfig = original
          ? (JSON.parse(original.input) as { config: P6ConfigSnapshot }).config
          : undefined
        let target = sourceRunId
        // 结束咨询只适用于没有未完成任务和退款关联的普通咨询
        if (action === 'end_consultation') {
          if (
            !source ||
            source.status !== 'awaiting_input' ||
            busy ||
            refund ||
            originalConfig?.value.toolVersion !== 'customer-guidance-v1'
          )
            throw new DomainError(createToolError('CONFLICT', '当前会话不能结束咨询'))
        } else if (source?.status !== 'escalated' && source?.status !== 'handling_human') {
          // 原业务和失败任务保持原状 人工沟通只关联来源而不取得执行权
          if (!source || source.status !== 'awaiting_input' || busy || refund || !originalConfig) {
            const linked = this.db
              .prepare(
                `SELECT r.run_id AS runId FROM agent_runs r JOIN agent_events e ON e.run_id = r.run_id
            WHERE r.customer_id = ? AND r.status IN ('escalated','handling_human') AND e.type = 'human.requested'
            AND json_extract(e.payload_json, '$.sourceRunId') IS ? ORDER BY r.created_at DESC LIMIT 1`,
              )
              .get(customerId, sourceRunId ?? null) as { runId: string } | undefined
            target = linked?.runId
          }
        }
        // 人工转接可能返回另一会话 配置应随目标而非强行沿用来源
        const targetOriginal = target
          ? (this.db
              .prepare(
                'SELECT input_json AS input FROM p6_commands WHERE run_id = ? ORDER BY rowid LIMIT 1',
              )
              .get(target) as { input: string } | undefined)
          : undefined
        const frozen = targetOriginal
          ? (JSON.parse(targetOriginal.input) as { config: P6ConfigSnapshot }).config
          : config
        const task = this.tasks.accept({
          customerId,
          requestKey,
          kind: target ? 'message' : 'start',
          runId: target,
          config: frozen,
          requestPayload: payload,
          source: 'customer',
          plan: { input: action, tool: 'customer_control' },
        })
        // 控制命令不占用 Worker 配额 受理结果与公开事件在同一次提交中可见
        this.db
          .prepare(
            "UPDATE p6_tasks SET status = 'completed' WHERE task_id = ? AND status = 'queued'",
          )
          .run(task.taskId)
        this.db
          .prepare(
            "INSERT INTO p6_events(task_id,event_key,payload_json) VALUES (?,'status:completed',?)",
          )
          .run(task.taskId, JSON.stringify({ status: 'completed', action }))
        const state = this.db
          .prepare('SELECT status FROM agent_runs WHERE run_id = ?')
          .get(task.runId) as { status: string }
        if (action === 'human' && ['escalated', 'handling_human'].includes(state.status))
          return this.tasks.get(task.taskId)!
        if (!target)
          this.append(task.runId, 'run.started', {
            customerId,
            promptVersion: frozen.promptVersion,
            model: frozen.model,
          })
        const text =
          action === 'human'
            ? '已申请人工帮助 请等待售后专员接管'
            : '本次咨询已结束 如需其他帮助可以新建咨询'
        this.append(task.runId, 'message.user', {
          text: action === 'human' ? '申请人工帮助' : '结束咨询',
          requestKey,
        })
        this.append(task.runId, 'message.completed', { role: 'assistant', text })
        if (action === 'human')
          this.append(task.runId, 'human.requested', {
            sourceRunId: sourceRunId && sourceRunId !== task.runId ? sourceRunId : null,
          })
        this.db
          .prepare('UPDATE agent_runs SET status = ?, updated_at = ? WHERE run_id = ?')
          .run(action === 'human' ? 'escalated' : 'completed', new Date().toISOString(), task.runId)
        this.append(
          task.runId,
          action === 'human' ? 'run.escalated' : 'run.completed',
          action === 'human' ? { reason: text } : { summary: text, escalated: false },
        )
        return this.tasks.get(task.taskId)!
      })
      .immediate()
  }

  /** 确认记录与对应客户事件原子提交 旧所有者与取消后的迟到结果不能写回 */
  commit(task: P6Task, step: string, value: unknown, work: () => void): void {
    this.tasks.fenced(task, () => {
      const current = this.tasks.assertOwned(task)
      if (current.cancelRequested || current.deadline <= Date.now())
        throw new Error('会话已取消或超时')
      // 已确认步骤不再重复写事件 防止恢复后重复回复
      if (this.tasks.step(task.taskId, step) !== undefined) return
      // 本地事件工作与确认点共同提交 任一失败一起回滚
      work()
      this.tasks.checkpoint(task, step, value)
    })
  }

  /** 对话暂停与任务完成一并提交 允许下一条消息安全受理 */
  finish(
    task: P6Task,
    status: 'awaiting_input' | 'completed' | 'escalated',
    payload: {
      summary?: string
      hint?: string
      toolCallId?: string
      missingSlot?: string
      consultation?: 'ready' | 'clarify'
      showChoices?: boolean
    },
  ): void {
    this.tasks.fenced(task, () => {
      const current = this.tasks.assertOwned(task)
      if (current.cancelRequested || current.deadline <= Date.now())
        throw new Error('会话已取消或超时')
      this.db
        .prepare('UPDATE agent_runs SET status = ?, updated_at = ? WHERE run_id = ?')
        .run(status, new Date().toISOString(), task.runId)
      this.append(
        task.runId,
        status === 'awaiting_input'
          ? 'run.paused'
          : status === 'completed'
            ? 'run.completed'
            : 'run.escalated',
        status === 'awaiting_input'
          ? { reason: status, ...payload }
          : status === 'completed'
            ? { summary: payload.summary, escalated: false }
            : { reason: payload.summary },
      )
      // 会话可以停在等待输入 这里只结束本轮可执行片段
      this.tasks.finish(task, 'completed')
    })
  }
}
