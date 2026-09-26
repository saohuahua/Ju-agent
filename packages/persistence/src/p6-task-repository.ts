import { createHash, randomUUID } from 'node:crypto'
import type { SqliteDatabase } from './db.js'
import type {
  P6Claim,
  P6CommandInput,
  P6Limits,
  P6Payment,
  P6PaymentResult,
  P6Status,
  P6Task,
} from '../../contracts/src/p6-durable.js'

/** 键排序消除对象属性顺序差异 数组顺序仍属于请求语义 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const columns = `t.task_id AS taskId, t.command_id AS commandId, t.run_id AS runId,
 t.customer_id AS customerId, t.provider, t.tool, t.approval_id AS approvalId, t.status,
 t.owner, t.generation, t.lease_until AS leaseUntil, t.attempt,
 t.cancel_requested AS cancelRequested, t.deadline, t.error, c.input_json AS inputJson`

export class P6OwnershipLost extends Error {}

export class P6TaskRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly now = Date.now,
  ) {}

  /** 运行与命令及任务同事务落库 返回前提交 同键异参明确冲突 */
  accept(input: P6CommandInput, lifetimeMs = 300_000): P6Task {
    if (!input.requestKey || !input.customerId || !input.config.snapshotId || lifetimeMs <= 0) {
      throw new Error('无效受理参数')
    }
    const payment = input.plan.payment
    if (
      payment &&
      (!payment.businessKey ||
        !payment.resourceId ||
        !payment.currency ||
        !Number.isSafeInteger(payment.amountCents) ||
        payment.amountCents <= 0)
    )
      throw new Error('无效资金计划')
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare(
            `SELECT command_id AS commandId, fingerprint FROM p6_commands
        WHERE customer_id = ? AND request_key = ?`,
          )
          .get(input.customerId, input.requestKey) as
          { commandId: string; fingerprint: string } | undefined
        const hash = fingerprint(
          input.requestPayload
            ? {
                customerId: input.customerId,
                kind: input.kind,
                runId: input.runId,
                requestPayload: input.requestPayload,
              }
            : input,
        )
        if (existing) {
          if (existing.fingerprint !== hash) throw new Error('请求幂等键内容冲突')
          return this.getByCommand(existing.commandId)
        }
        const runId = input.runId ?? `run_${randomUUID()}`
        const iso = new Date(this.now()).toISOString()
        if (input.runId) {
          const run = this.db
            .prepare('SELECT customer_id AS customerId FROM agent_runs WHERE run_id = ?')
            .get(runId) as { customerId: string } | undefined
          if (run?.customerId !== input.customerId) throw new Error('运行归属冲突')
          const original = this.db
            .prepare(
              'SELECT input_json AS input FROM p6_commands WHERE run_id = ? ORDER BY rowid LIMIT 1',
            )
            .get(runId) as { input: string } | undefined
          if (
            original &&
            fingerprint((JSON.parse(original.input) as P6CommandInput).config) !==
              fingerprint(input.config)
          ) {
            throw new Error('运行配置快照不可切换')
          }
        } else {
          this.db
            .prepare(
              `INSERT INTO agent_runs
          (run_id,customer_id,status,prompt_version,model,created_at,updated_at,source)
          VALUES (?,?,'created',?,?,?,?,?)`,
            )
            .run(
              runId,
              input.customerId,
              input.config.promptVersion,
              input.config.model,
              iso,
              iso,
              input.source ?? 'customer',
            )
        }
        const commandId = randomUUID()
        const taskId = randomUUID()
        this.db
          .prepare('INSERT INTO p6_commands VALUES (?,?,?,?,?,?)')
          .run(commandId, input.customerId, input.requestKey, hash, runId, JSON.stringify(input))
        this.db
          .prepare(
            `INSERT INTO p6_tasks
        (task_id,command_id,run_id,customer_id,provider,tool,approval_id,status,available_at,deadline)
        VALUES (?,?,?,?,?,?,?,'queued',?,?)`,
          )
          .run(
            taskId,
            commandId,
            runId,
            input.customerId,
            input.config.provider,
            input.plan.tool,
            input.approvalId ?? null,
            this.now(),
            this.now() + lifetimeMs,
          )
        return this.get(taskId)!
      })
      .immediate()
  }

  get(taskId: string): P6Task | undefined {
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM p6_tasks t JOIN p6_commands c
      ON c.command_id = t.command_id WHERE task_id = ?`,
      )
      .get(taskId) as (Omit<P6Task, 'input'> & { inputJson: string }) | undefined
    if (!row) return undefined
    const { inputJson, ...task } = row
    return { ...task, input: JSON.parse(inputJson) as P6CommandInput }
  }

  findRequest(customerId: string, requestKey: string): P6Task | undefined {
    const row = this.db
      .prepare('SELECT command_id AS id FROM p6_commands WHERE customer_id = ? AND request_key = ?')
      .get(customerId, requestKey) as { id: string } | undefined
    return row ? this.getByCommand(row.id) : undefined
  }

  private getByCommand(commandId: string): P6Task {
    const row = this.db
      .prepare('SELECT task_id AS id FROM p6_tasks WHERE command_id = ?')
      .get(commandId) as { id: string }
    return this.get(row.id)!
  }

  /**
   * 扫描仅限尚未认领的审批意图 映射器须只读且验证原审批与业务计划绑定
   * 意图占用与受理在同事务提交 旧执行器已认领的历史意图绝不自动接管
   */
  bridgeApprovals(map: (approvalId: string) => P6CommandInput): number {
    return this.db
      .transaction(() => {
        const intents = this.db
          .prepare(
            `SELECT approval_id AS id, run_id AS runId FROM approval_execution_intents
        WHERE status = 'pending' ORDER BY created_at LIMIT 100`,
          )
          .all() as { id: string; runId: string }[]
        for (const intent of intents) {
          const input = map(intent.id)
          if (
            input.approvalId !== intent.id ||
            input.runId !== intent.runId ||
            input.kind !== 'approval'
          ) {
            throw new Error('审批映射绑定冲突')
          }
          this.accept(input)
          this.db
            .prepare(
              `UPDATE approval_execution_intents SET status = 'running', updated_at = ?
          WHERE approval_id = ? AND status = 'pending'`,
            )
            .run(new Date(this.now()).toISOString(), intent.id)
        }
        return intents.length
      })
      .immediate()
  }

  /** 所有并发配额在同一写事务内核算 过期任务接管增加代次而不沿用旧所有者 */
  claim(
    owner: string,
    leaseMs: number,
    limits: P6Limits,
    tools?: readonly string[],
    acceptedEvent?: string,
  ): P6Task | undefined {
    if (
      !owner ||
      leaseMs <= 0 ||
      Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 1)
    ) {
      throw new Error('无效租约或并发上限')
    }
    return this.db
      .transaction(() => {
        const now = this.now()
        const row = this.db
          .prepare(
            `SELECT t.task_id AS id FROM p6_tasks t
        WHERE ((t.status = 'queued' AND t.available_at <= ?) OR (t.status = 'running' AND t.lease_until <= ?))
        AND (? IS NULL OR t.tool IN (SELECT value FROM json_each(?)))
        AND (? IS NULL OR EXISTS (SELECT 1 FROM p6_events e WHERE e.task_id = t.task_id AND e.event_key = ?))
        AND NOT EXISTS (SELECT 1 FROM p6_tasks a WHERE a.run_id = t.run_id AND a.status = 'running'
          AND a.lease_until > ?)
        AND (SELECT COUNT(*) FROM p6_tasks a WHERE a.status = 'running' AND a.lease_until > ?) < ?
        AND (SELECT COUNT(*) FROM p6_tasks a WHERE a.status = 'running' AND a.lease_until > ?
          AND a.customer_id = t.customer_id) < ?
        AND (SELECT COUNT(*) FROM p6_tasks a WHERE a.status = 'running' AND a.lease_until > ?
          AND a.provider = t.provider) < ?
        AND (SELECT COUNT(*) FROM p6_tasks a WHERE a.status = 'running' AND a.lease_until > ?
          AND a.tool = t.tool) < ?
        ORDER BY t.available_at, t.task_id LIMIT 1`,
          )
          .get(
            now,
            now,
            tools ? JSON.stringify(tools) : null,
            tools ? JSON.stringify(tools) : null,
            acceptedEvent ?? null,
            acceptedEvent ?? null,
            now,
            now,
            limits.global,
            now,
            limits.customer,
            now,
            limits.provider,
            now,
            limits.tool,
          ) as { id: string } | undefined
        if (!row) return undefined
        this.db
          .prepare(
            `UPDATE p6_tasks SET status = 'running', owner = ?, lease_until = ?,
        generation = generation + 1, attempt = attempt + 1 WHERE task_id = ?`,
          )
          .run(owner, now + leaseMs, row.id)
        return this.get(row.id)
      })
      .immediate()
  }

  assertOwned(claim: P6Claim): P6Task {
    const task = this.get(claim.taskId)
    if (
      !task ||
      task.status !== 'running' ||
      task.owner !== claim.owner ||
      task.generation !== claim.generation ||
      task.leaseUntil <= this.now()
    )
      throw new P6OwnershipLost('租约已失效')
    return task
  }

  renew(claim: P6Claim, leaseMs: number): boolean {
    if (leaseMs <= 0) throw new Error('无效续约时长')
    return (
      this.db
        .prepare(
          `UPDATE p6_tasks SET lease_until = ? WHERE task_id = ? AND status = 'running'
      AND owner = ? AND generation = ? AND lease_until > ?`,
        )
        .run(this.now() + leaseMs, claim.taskId, claim.owner, claim.generation, this.now())
        .changes === 1
    )
  }

  /** 所有状态写回都先在写事务中验证租约 业务记账回调只能同步写同库 */
  fenced<T>(claim: P6Claim, work: () => T): T {
    return this.db
      .transaction(() => {
        this.assertOwned(claim)
        return work()
      })
      .immediate()
  }

  checkpoint(claim: P6Claim, step: string, value: unknown): void {
    this.fenced(claim, () => {
      this.db
        .prepare('INSERT INTO p6_steps VALUES (?,?,?) ON CONFLICT DO NOTHING')
        .run(claim.taskId, step, JSON.stringify(value))
      this.event(claim, `step:${step}`, value)
    })
  }

  step(taskId: string, step: string): unknown {
    const row = this.db
      .prepare('SELECT value_json AS value FROM p6_steps WHERE task_id = ? AND step = ?')
      .get(taskId, step) as { value: string } | undefined
    return row ? JSON.parse(row.value) : undefined
  }

  event(claim: P6Claim, key: string, value: unknown): void {
    this.fenced(claim, () =>
      this.db
        .prepare(
          `INSERT INTO p6_events
      (task_id,event_key,payload_json) VALUES (?,?,?) ON CONFLICT DO NOTHING`,
        )
        .run(claim.taskId, key, JSON.stringify(value)),
    )
  }

  events(taskId: string, after = 0) {
    return this.db
      .prepare(
        `SELECT cursor, event_key AS eventKey, payload_json AS payloadJson FROM p6_events
      WHERE task_id = ? AND cursor > ? ORDER BY cursor LIMIT 100`,
      )
      .all(taskId, after) as { cursor: number; eventKey: string; payloadJson: string }[]
  }

  finish(
    claim: P6Claim,
    status: Exclude<P6Status, 'running' | 'queued'>,
    error: string | null = null,
  ): void {
    this.fenced(claim, () => {
      const task = this.get(claim.taskId)!
      this.event(claim, `status:${status}`, { status, error })
      this.db
        .prepare(`UPDATE p6_tasks SET status = ?, error = ?, lease_until = 0 WHERE task_id = ?`)
        .run(status, error, claim.taskId)
      // 会话执行耗尽或取消时同步公开失败状态 不泄漏内部异常或让客户永久等待
      if (task.input.plan.tool === 'conversation' && status !== 'completed') {
        this.db
          .prepare(
            "UPDATE agent_runs SET status = 'failed', error = ?, updated_at = ? WHERE run_id = ? AND status = 'running'",
          )
          .run('处理已中断 请联系人工核验', new Date(this.now()).toISOString(), task.runId)
        this.db
          .prepare(
            `INSERT INTO agent_events (run_id, sequence, type, payload_json, created_at)
          SELECT ?, COALESCE(MAX(sequence), 0) + 1, 'run.failed', ?, ? FROM agent_events WHERE run_id = ?`,
          )
          .run(
            task.runId,
            JSON.stringify({ errorCode: 'INTERNAL_ERROR', message: '处理已中断 请联系人工核验' }),
            new Date(this.now()).toISOString(),
            task.runId,
          )
      }
      if (task.approvalId && status !== 'needs_confirmation') {
        this.db
          .prepare(
            `UPDATE approval_execution_intents SET status = ?, last_error = ?, updated_at = ?
          WHERE approval_id = ? AND status = 'running'`,
          )
          .run(
            status === 'completed' || status === 'business_failed' ? 'completed' : 'failed',
            error,
            new Date(this.now()).toISOString(),
            task.approvalId,
          )
      }
    })
  }

  release(claim: P6Claim, error: string, delayMs: number): void {
    this.fenced(claim, () =>
      this.db
        .prepare(
          `UPDATE p6_tasks SET status = 'queued', error = ?,
      available_at = ?, lease_until = 0 WHERE task_id = ?`,
        )
        .run(error, this.now() + Math.max(0, delayMs), claim.taskId),
    )
  }

  /** 取消请求不清除资金事实 Worker 在发送前停止 或在发送后仅查询核验 */
  cancel(taskId: string, customerId: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE p6_tasks SET cancel_requested = 1 WHERE task_id = ? AND customer_id = ?
      AND status IN ('queued','running','needs_confirmation')`,
        )
        .run(taskId, customerId).changes === 1
    )
  }

  /** 只恢复结果查询 不清除发送标记 所以人工触发也不会自动重放未知资金动作 */
  reconcile(taskId: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE p6_tasks SET status = 'queued', available_at = ? WHERE task_id = ?
      AND status = 'needs_confirmation'`,
        )
        .run(this.now(), taskId).changes === 1
    )
  }

  effect(payment: P6Payment): { status: string; result: P6PaymentResult | null } | undefined {
    const row = this.db
      .prepare(
        `SELECT fingerprint, status, result_json AS result FROM p6_effects
      WHERE business_key = ?`,
      )
      .get(payment.businessKey) as
      { fingerprint: string; status: string; result: string | null } | undefined
    if (!row) return undefined
    if (row.fingerprint !== fingerprint(payment)) throw new Error('业务幂等键内容冲突')
    return {
      status: row.status,
      result: row.result ? (JSON.parse(row.result) as P6PaymentResult) : null,
    }
  }

  /** 业务键跨运行共享 先持久化发送意图 再调用渠道 崩溃空窗只能查询 */
  beginPayment(
    claim: P6Claim,
    payment: P6Payment,
    prepare?: (db: SqliteDatabase, payment: P6Payment, task: P6Task) => void,
  ): boolean {
    return this.fenced(claim, () => {
      const task = this.assertOwned(claim)
      if (task.cancelRequested || task.deadline <= this.now()) return false
      if (this.effect(payment)) return false
      prepare?.(this.db, payment, task)
      this.db
        .prepare(`INSERT INTO p6_effects VALUES (?,?,?,'sending',NULL,?)`)
        .run(payment.businessKey, fingerprint(payment), JSON.stringify(payment), claim.taskId)
      return true
    })
  }

  /** 渠道终态与本地业务回写及检查点原子提交 回调抛错全部回滚 留待再次查询 */
  settle(
    claim: P6Claim,
    payment: P6Payment,
    result: P6PaymentResult,
    apply: (db: SqliteDatabase, payment: P6Payment, result: P6PaymentResult) => void,
  ): void {
    this.fenced(claim, () => {
      const prior = this.effect(payment)
      if (!prior) throw new Error('缺少已持久化资金意图')
      if (prior.status === 'succeeded' || prior.status === 'rejected') return
      const status = result.status === 'not_found' ? 'unknown' : result.status
      if (status === 'succeeded' || status === 'rejected') {
        const applied: unknown = apply(this.db, payment, result)
        if (applied && typeof applied === 'object' && 'then' in applied)
          throw new Error('业务回写禁止异步回调')
      }
      this.db
        .prepare('UPDATE p6_effects SET status = ?, result_json = ? WHERE business_key = ?')
        .run(status, JSON.stringify(result), payment.businessKey)
      if (status === 'succeeded' || status === 'rejected') this.checkpoint(claim, 'payment', result)
    })
  }
}
