import { randomUUID } from 'node:crypto'
import type { P6ConfigSnapshot, P6Task, P7Snapshot } from '@aftersales/contracts'
import {
  P6TaskRepository,
  P6OwnedAfterSale,
  ConversationJournal,
  acceptExecutionOwnedCommand,
  p6ApprovalCommand,
  p6PaymentClient,
  executionOwnershipPreparePayment,
  executionOwnershipApplyPayment,
  type SqliteDatabase,
} from '@aftersales/persistence'
import { P6Worker } from './p6-worker.js'
import { p6ConfigFromP7 } from './p6-config-snapshot.js'
import { restoreP7Snapshot } from './p7-snapshot.js'
import { P6ConversationRefundRepository } from '../../persistence/src/p6-conversation-refund.js'

export interface DurableBusinessOptions {
  snapshot: P7Snapshot
  /** 只允许独立本机模拟渠道 不接受任意资金端口 */
  paymentUrl: string
  leaseMs?: number
  boundary?(name: string, task: P6Task): Promise<void>
}

/** 已有审批的持久调度 不生成资格金额 不调用模型重新规划已批准动作 */
export class DurableBusiness {
  readonly worker: P6Worker
  private readonly tasks: P6TaskRepository
  private stopped = true
  private loop?: Promise<void>

  constructor(
    private readonly db: SqliteDatabase,
    private readonly options: DurableBusinessOptions,
  ) {
    if (restoreP7Snapshot(options.snapshot).mode !== 'simulation')
      throw new Error('持久业务只开放本地模拟')
    this.tasks = new P6TaskRepository(db)
    this.worker = new P6Worker(
      this.tasks,
      {
        // 批准方案只确认确定性执行步骤 不为已有授权额外发起模型请求
        model: async () => ({ source: 'approved-business-plan' }),
        read: async () => ({ source: 'validated-at-payment-prepare' }),
        payment: p6PaymentClient(options.paymentUrl),
        preparePayment: executionOwnershipPreparePayment,
        applyPayment: executionOwnershipApplyPayment,
        boundary: options.boundary,
      },
      {
        owner: `business-${randomUUID()}`,
        tools: ['return_request', 'after_sale_wait', 'compensation', 'price_protection'],
        acceptedEvent: 'business-accepted',
        leaseMs: options.leaseMs ?? 5000,
        callTimeoutMs: 5000,
        maxAttempts: 3,
        retryDelayMs: 100,
        limits: { global: 4, customer: 1, provider: 4, tool: 4 },
      },
    )
  }

  private config(runId: string): P6ConfigSnapshot {
    const original = this.db
      .prepare(
        'SELECT input_json AS input FROM p6_commands WHERE run_id = ? ORDER BY rowid LIMIT 1',
      )
      .get(runId) as { input: string } | undefined
    // 旧审批显式采用本次模拟配置 新运行后续命令始终恢复原快照
    return original
      ? (JSON.parse(original.input) as { config: P6ConfigSnapshot }).config
      : p6ConfigFromP7(this.options.snapshot)
  }

  acceptApproval(approvalId: string): P6Task {
    return this.db
      .transaction(() => {
        const approval = this.db
          .prepare(
            'SELECT run_id AS runId, resource_type AS type FROM approval_requests WHERE approval_id = ?',
          )
          .get(approvalId) as { runId: string; type: string } | undefined
        if (!approval) throw new Error('审批不存在')
        const refunds = new P6ConversationRefundRepository(this.db)
        const link = refunds.link(approval.runId)
        if (link) {
          refunds.validate(link)
          if (link.approval_id !== approvalId) throw new Error('原会话审批关联冲突')
        }
        const config = this.config(approval.runId)
        if (approval.type === 'return_request')
          return this.accepted(new P6OwnedAfterSale(this.db).acceptApproval(approvalId, config))
        const existing = this.db
          .prepare('SELECT task_id AS taskId FROM p6_tasks WHERE approval_id = ?')
          .get(approvalId) as { taskId: string } | undefined
        if (existing) {
          if (
            !this.db
              .prepare(
                "SELECT 1 FROM p6_events WHERE task_id = ? AND event_key = 'business-accepted'",
              )
              .get(existing.taskId)
          )
            throw new Error('历史任务未通过本入口接管')
          return this.tasks.get(existing.taskId)!
        }
        const task = acceptExecutionOwnedCommand(
          this.db,
          p6ApprovalCommand(this.db, approvalId, config),
        )
        this.db
          .prepare(
            "UPDATE approval_execution_intents SET status = 'running' WHERE approval_id = ? AND status = 'pending'",
          )
          .run(approvalId)
        return this.accepted(task)
      })
      .immediate()
  }

  private accepted(task: P6Task): P6Task {
    if (!this.db.inTransaction) throw new Error('接管凭据必须与受理同事务')
    this.db
      .prepare(
        "INSERT OR IGNORE INTO p6_events(task_id,event_key,payload_json) VALUES (?,'business-accepted','{}')",
      )
      .run(task.taskId)
    return task
  }

  receive(returnNo: string): P6Task {
    if (this.db.prepare('SELECT 1 FROM p6_conversation_refunds WHERE return_no = ?').get(returnNo))
      return this.db
        .transaction(() =>
          this.accepted(new P6ConversationRefundRepository(this.db).receive(returnNo)),
        )
        .immediate()
    const row = this.db
      .prepare(
        `SELECT a.approval_id AS approvalId, a.run_id AS runId, r.customer_id AS customerId
      FROM approval_requests a JOIN return_requests r ON r.return_no = a.resource_id
      JOIN p6_tasks t ON t.approval_id = a.approval_id
      WHERE a.resource_type = 'return_request' AND a.resource_id = ? AND a.status = 'approved'`,
      )
      .get(returnNo) as { approvalId: string; runId: string; customerId: string } | undefined
    if (!row) throw new Error('收货缺少已接管的持久审批')
    return this.db
      .transaction(() => this.accepted(new P6OwnedAfterSale(this.db).receive({ ...row, returnNo })))
      .immediate()
  }

  owns(runId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM p6_tasks WHERE run_id = ? AND tool != 'conversation'")
        .get(runId),
    )
  }

  /** 每次扫描都恢复尚未投影的终态 进程退出不丢失结果事件 */
  async runOnce(): Promise<boolean> {
    const expired = this.db
      .prepare(
        `SELECT a.approval_id AS id, a.run_id AS runId FROM approval_requests a
      JOIN return_requests r ON r.return_no = a.resource_id WHERE a.resource_type = 'return_request'
      AND r.status = 'awaiting_approval' AND a.expires_at <= ? AND a.status IN ('pending','approved','expired') LIMIT 100`,
      )
      .all(new Date().toISOString()) as { id: string; runId: string }[]
    for (const item of expired) {
      try {
        this.db
          .transaction(() => {
            new P6OwnedAfterSale(this.db).expireApproval(item.id)
            if (new P6ConversationRefundRepository(this.db).link(item.runId)) return
            const journal = new ConversationJournal(this.db, this.tasks)
            journal.append(item.runId, 'message.completed', {
              role: 'assistant',
              text: '审批已过期 未执行资金动作 请联系人工重新核验',
            })
            journal.append(item.runId, 'run.escalated', { reason: '审批已过期' })
            this.db
              .prepare(
                "UPDATE agent_runs SET status = 'escalated' WHERE run_id = ? AND status = 'awaiting_approval'",
              )
              .run(item.runId)
          })
          .immediate()
      } catch {
        // 历史资金未知与已接管授权保持原状 不能因时钟到期释放许可
      }
    }
    const pending = this.db
      .prepare("SELECT approval_id AS id FROM approval_execution_intents WHERE status = 'pending'")
      .all() as { id: string }[]
    for (const item of pending) {
      try {
        const accepted = this.acceptApproval(item.id)
        await this.options.boundary?.('after-approval-accept', accepted)
      } catch {
        // 坏审批保持原事实并留下可见错误 不阻塞其他已受理任务
        this.db
          .prepare(
            "UPDATE approval_execution_intents SET last_error = '持久受理失败 请核验授权与执行权' WHERE approval_id = ? AND status = 'pending'",
          )
          .run(item.id)
      }
    }
    const claimed = await this.worker.runOnce()
    // 业务终态已经提交 此边界退出后只恢复投影
    const terminal = this.db
      .prepare(
        "SELECT task_id AS id FROM p6_tasks WHERE tool != 'conversation' AND status NOT IN ('queued','running') ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { id: string } | undefined
    if (terminal)
      await this.options.boundary?.('before-business-projection', this.tasks.get(terminal.id)!)
    new P6ConversationRefundRepository(this.db).project()
    this.project()
    return claimed
  }

  private project(): void {
    this.db
      .transaction(() => {
        const rows = this.db
          .prepare(
            `SELECT t.task_id AS id FROM p6_tasks t WHERE tool != 'conversation'
        AND status NOT IN ('queued','running') AND NOT EXISTS
        (SELECT 1 FROM p6_events e WHERE e.task_id = t.task_id AND e.event_key = 'business-projected')
        AND EXISTS (SELECT 1 FROM p6_events accepted WHERE accepted.task_id = t.task_id AND accepted.event_key = 'business-accepted')
        AND NOT EXISTS (SELECT 1 FROM p6_conversation_refunds f WHERE f.run_id = t.run_id)`,
          )
          .all() as { id: string }[]
        const journal = new ConversationJournal(this.db, this.tasks)
        for (const row of rows) {
          const task = this.tasks.get(row.id)!
          const waiting = task.status === 'completed' && task.input.plan.tool === 'after_sale_wait'
          const summary =
            task.status !== 'completed'
              ? '处理结果需人工核验'
              : waiting
                ? '审批已通过 等待买家寄回 尚未退款'
                : task.input.plan.payment
                  ? '模拟渠道已确认资金结果'
                  : '已记录审批或收货结果'
          // 仅回填仍挂起的原动作 不伪造新的模型轮次或将等待任务解释为退款完成
          const calls = new Map<string, { toolCallId: string; toolName: string }>()
          for (const event of journal.events(task.runId)) {
            if (event.type === 'agent.turn') {
              const payload = event.payload as {
                blocks?: { type: string; toolCallId: string; toolName: string }[]
              }
              for (const block of payload.blocks ?? [])
                if (block.type === 'tool_use') calls.set(block.toolCallId, block)
            } else if (event.type === 'agent.tool_results') {
              for (const result of (event.payload as { results: { toolCallId: string }[] }).results)
                calls.delete(result.toolCallId)
            }
          }
          const pending = [...calls.values()].filter((call) =>
            [
              'submit_return',
              'submit_refund_only',
              'submit_exchange',
              'compensation',
              'price_protection',
            ].includes(call.toolName),
          )
          if (pending.length === 1)
            journal.append(task.runId, 'agent.tool_results', {
              results: [
                {
                  ...pending[0],
                  content: JSON.stringify({ summary, taskStatus: task.status }),
                  isError: task.status !== 'completed',
                },
              ],
            })
          journal.append(task.runId, 'message.completed', { role: 'assistant', text: summary })
          const status =
            task.status === 'completed' ? (waiting ? 'awaiting_input' : 'completed') : 'escalated'
          this.db
            .prepare(
              "UPDATE agent_runs SET status = ?, updated_at = ? WHERE run_id = ? AND status NOT IN ('completed','escalated')",
            )
            .run(status, new Date().toISOString(), task.runId)
          journal.append(
            task.runId,
            waiting ? 'run.paused' : status === 'completed' ? 'run.completed' : 'run.escalated',
            {
              reason: waiting ? 'awaiting_input' : summary,
              summary,
              escalated: status === 'escalated',
            },
          )
          this.db
            .prepare(
              "INSERT INTO p6_events(task_id,event_key,payload_json) VALUES (?,'business-projected','{}')",
            )
            .run(task.taskId)
        }
      })
      .immediate()
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.loop = (async () => {
      while (!this.stopped) {
        try {
          await this.runOnce()
        } catch (error) {
          console.error('持久业务扫描失败', error)
        }
        if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, 100))
      }
    })()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.loop
  }
}
