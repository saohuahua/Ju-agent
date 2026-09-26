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

  append(runId: string, type: string, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO agent_events (run_id, sequence, type, payload_json, created_at)
      SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ? FROM agent_events WHERE run_id = ?`,
      )
      .run(runId, type, JSON.stringify(redactDeep(payload)), new Date().toISOString(), runId)
  }

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
        const payload = {
          message,
          runId: runId ?? null,
          ...(returnShipment ? { returnShipment } : {}),
        }
        const existing = this.tasks.findRequest(customerId, requestKey)
        if (existing) {
          // 同键冲突必须在写入前报错 不静默复用另一条消息
          if (JSON.stringify(existing.input.requestPayload) !== JSON.stringify(payload)) {
            throw new DomainError(createToolError('CONFLICT', '请求键已用于不同消息'))
          }
          return existing
        }
        let frozen = config
        let replyToToolCallId: string | undefined
        if (runId) {
          const run = this.db
            .prepare('SELECT customer_id AS customerId, status FROM agent_runs WHERE run_id = ?')
            .get(runId) as { customerId: string; status: string } | undefined
          if (!run || run.customerId !== customerId)
            throw new DomainError(createToolError('AUTHORIZATION_DENIED', '无权访问该会话'))
          const refunds = new P6ConversationRefundRepository(this.db)
          const link = refunds.link(runId)
          if (link) {
            if (link.projected || !['awaiting_input', 'awaiting_approval'].includes(run.status))
              throw new DomainError(createToolError('CONFLICT', '原售后流程当前不接受补充'))
            try {
              const { origin } = refunds.validate(link)
              if (returnShipment)
                refunds.shipment(
                  runId,
                  customerId,
                  returnShipment.returnNo,
                  returnShipment.trackingNo,
                )
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
          const pause = this.db
            .prepare(
              "SELECT payload_json AS payload FROM agent_events WHERE run_id = ? AND type = 'run.paused' ORDER BY sequence DESC LIMIT 1",
            )
            .get(runId) as { payload: string } | undefined
          replyToToolCallId = pause
            ? (JSON.parse(pause.payload) as { toolCallId?: string }).toolCallId
            : undefined
        }
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
          ...(replyToToolCallId ? { replyToToolCallId } : {}),
        })
        return task
      })
      .immediate()
  }

  events(runId: string): Array<{ type: string; payload: unknown }> {
    const rows = this.db
      .prepare(
        'SELECT type, payload_json AS payload FROM agent_events WHERE run_id = ? ORDER BY sequence',
      )
      .all(runId) as Array<{ type: string; payload: string }>
    return rows.map((row) => ({ type: row.type, payload: JSON.parse(row.payload) }))
  }

  /** 确认记录与对应客户事件原子提交 旧所有者与取消后的迟到结果不能写回 */
  commit(task: P6Task, step: string, value: unknown, work: () => void): void {
    this.tasks.fenced(task, () => {
      const current = this.tasks.assertOwned(task)
      if (current.cancelRequested || current.deadline <= Date.now())
        throw new Error('会话已取消或超时')
      if (this.tasks.step(task.taskId, step) !== undefined) return
      work()
      this.tasks.checkpoint(task, step, value)
    })
  }

  /** 对话暂停与任务完成一并提交 允许下一条消息安全受理 */
  finish(
    task: P6Task,
    status: 'awaiting_input' | 'completed' | 'escalated',
    payload: { summary?: string; hint?: string; toolCallId?: string },
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
      this.tasks.finish(task, 'completed')
    })
  }
}
