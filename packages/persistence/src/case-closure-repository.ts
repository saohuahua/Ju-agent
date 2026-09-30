import { createToolError } from '@aftersales/contracts'
import {
  closureBlockers,
  DomainError,
  type Actor,
  type CaseClosureRepository,
  type CaseClosureReview,
  type ClosureResource,
  type ClosureResourceType,
} from '@aftersales/domain'
import type { SqliteDatabase } from './db.js'

const BUSINESS_TYPES = new Set<ClosureResourceType>([
  'refund',
  'compensation',
  'price_protection',
  'return_request',
])

/**
 * 从服务端审计 审批和全部断点读取实际关联 不从客户文本或失败工具参数猜测单号
 * 不新增资金动作 只核验当前数据库事实并原子完成案件结案
 */
export class SqliteCaseClosureRepository implements CaseClosureRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private inspect(runId: string): CaseClosureReview {
    const run = this.db
      .prepare('SELECT status, customer_id AS customerId FROM agent_runs WHERE run_id = ?')
      .get(runId) as { status: CaseClosureReview['status']; customerId: string } | undefined
    if (!run) throw new DomainError(createToolError('NOT_FOUND', '案件不存在'))

    const resources = new Map<string, ClosureResource>()
    const linked = new Map<string, { type: ClosureResourceType; id: string }>()
    const addLink = (type: ClosureResourceType, id: unknown) => {
      if (typeof id === 'string' && id) linked.set(`${type}:${id}`, { type, id })
    }
    const addResource = (resource: ClosureResource) =>
      resources.set(`${resource.resourceType}:${resource.resourceId}`, resource)

    const audits = this.db
      .prepare(
        `SELECT resource_type AS type, resource_id AS id FROM audit_logs
      WHERE run_id = ? AND action NOT LIKE '%access_denied'`,
      )
      .all(runId) as Array<{ type: ClosureResourceType; id: string }>
    for (const audit of audits) if (BUSINESS_TYPES.has(audit.type)) addLink(audit.type, audit.id)

    const approvals = this.db
      .prepare(
        `SELECT approval_id AS id, resource_type AS type, resource_id AS resourceId, status
      FROM approval_requests WHERE run_id = ?`,
      )
      .all(runId) as Array<{
      id: string
      type: ClosureResourceType
      resourceId: string
      status: string
    }>
    for (const approval of approvals) {
      addResource({ resourceType: 'approval', resourceId: approval.id, status: approval.status })
      if (BUSINESS_TYPES.has(approval.type)) addLink(approval.type, approval.resourceId)
      else addResource({ resourceType: 'evidence', resourceId: approval.id, status: 'unverified' })
    }

    const checkpoints = this.db
      .prepare('SELECT id, state_json AS state FROM checkpoints WHERE run_id = ?')
      .all(runId) as Array<{ id: number; state: string }>
    for (const checkpoint of checkpoints) {
      try {
        const state = JSON.parse(checkpoint.state) as Record<string, unknown>
        if (!state || typeof state !== 'object' || Array.isArray(state))
          throw new Error('invalid checkpoint')
        // 已声明的业务关联必须能解析 避免损坏单号被当成没有资金业务
        const fields = {
          returnNo: 'return_request',
          refundNo: 'refund',
          compensationNo: 'compensation',
          protectionNo: 'price_protection',
        } as const
        for (const [field, type] of Object.entries(fields)) {
          if (!(field in state) || state[field] === null) continue
          if (typeof state[field] !== 'string' || !state[field].trim())
            throw new Error('invalid resource reference')
          addLink(type, state[field])
        }
      } catch {
        addResource({
          resourceType: 'evidence',
          resourceId: `checkpoint-${checkpoint.id}`,
          status: 'unverified',
        })
      }
    }

    // 持久命令是独立关联证据 即使业务审计缺失也不能绕过未完成资金任务
    const tasks = this.db
      .prepare(
        `SELECT t.task_id AS id, t.status, c.input_json AS input
      FROM p6_tasks t JOIN p6_commands c ON c.command_id = t.command_id WHERE t.run_id = ?`,
      )
      .all(runId) as Array<{ id: string; status: string; input: string }>
    for (const task of tasks) {
      addResource({ resourceType: 'task', resourceId: task.id, status: task.status })
      try {
        const input = JSON.parse(task.input)
        if (!input || typeof input !== 'object' || !input.plan || typeof input.plan !== 'object')
          throw new Error('invalid plan')
        const payment = input.plan.payment
        if (payment === undefined) continue
        if (
          !payment ||
          typeof payment.resourceId !== 'string' ||
          typeof payment.businessKey !== 'string'
        )
          throw new Error('invalid payment')
        const separator = payment.resourceId.indexOf(':')
        const type = payment.resourceId.slice(0, separator) as ClosureResourceType
        const id = payment.resourceId.slice(separator + 1)
        if (separator < 1 || !id || !BUSINESS_TYPES.has(type)) throw new Error('invalid resource')
        addLink(type, id)
        const effect = this.db
          .prepare('SELECT status FROM p6_effects WHERE business_key = ?')
          .get(payment.businessKey) as { status: string } | undefined
        if (effect)
          addResource({
            resourceType: 'payment_effect',
            resourceId: payment.businessKey,
            status: effect.status,
          })
        else if (task.status === 'completed')
          addResource({
            resourceType: 'payment_effect',
            resourceId: payment.businessKey,
            status: 'missing',
          })
      } catch {
        addResource({ resourceType: 'evidence', resourceId: task.id, status: 'unverified' })
      }
    }

    // 退款与售后单双向关联 避免只看到父单完成而遗漏失败的退款
    for (const link of linked.values()) {
      if (link.type === 'return_request') {
        const refunds = this.db
          .prepare('SELECT refund_no AS id FROM refunds WHERE return_no = ?')
          .all(link.id) as Array<{ id: string }>
        for (const refund of refunds) addLink('refund', refund.id)
        const parent = this.db
          .prepare(
            'SELECT type, status, refund_amount_cents AS amount FROM return_requests WHERE return_no = ?',
          )
          .get(link.id) as { type: string; status: string; amount: number } | undefined
        if (
          parent &&
          parent.type !== 'exchange' &&
          parent.amount > 0 &&
          !['rejected', 'expired', 'cancelled'].includes(parent.status) &&
          refunds.length === 0
        ) {
          addResource({
            resourceType: 'refund',
            resourceId: `${link.id} 关联退款`,
            status: 'missing',
          })
        }
      } else if (link.type === 'refund') {
        const refund = this.db
          .prepare('SELECT return_no AS id FROM refunds WHERE refund_no = ?')
          .get(link.id) as { id: string } | undefined
        if (refund) addLink('return_request', refund.id)
      }
    }

    // 表与列由固定映射选择 不接受外部输入作为 SQL 标识符
    const statements = {
      return_request:
        'SELECT status, customer_id AS customerId FROM return_requests WHERE return_no = ?',
      compensation:
        'SELECT status, customer_id AS customerId FROM compensations WHERE compensation_no = ?',
      price_protection:
        'SELECT status, customer_id AS customerId FROM price_protections WHERE protection_no = ?',
      refund: `SELECT f.status, r.customer_id AS customerId FROM refunds f
        LEFT JOIN return_requests r ON r.return_no = f.return_no WHERE f.refund_no = ?`,
    }
    for (const link of linked.values()) {
      const sql = statements[link.type as keyof typeof statements]
      const row = this.db.prepare(sql).get(link.id) as
        { status: string; customerId: string } | undefined
      addResource({
        resourceType: link.type,
        resourceId: link.id,
        status: !row ? 'missing' : row.customerId !== run.customerId ? 'unverified' : row.status,
      })
    }

    const intents = this.db
      .prepare('SELECT approval_id AS id, status FROM approval_execution_intents WHERE run_id = ?')
      .all(runId) as Array<{ id: string; status: string }>
    for (const intent of intents)
      addResource({ resourceType: 'execution', resourceId: intent.id, status: intent.status })

    const blockers = closureBlockers([...resources.values()])
    return {
      runId,
      status: run.status,
      canResolve: run.status === 'handling_human' && blockers.length === 0,
      blockers,
    }
  }

  async review(runId: string): Promise<CaseClosureReview> {
    // 预览读取同一个数据库快照 提交时仍会在写事务内重新检查
    return this.db.transaction(() => this.inspect(runId))()
  }

  async resolve(input: {
    runId: string
    summary: string
    actor: Actor
    now: string
  }): Promise<{ resolved: boolean; review: CaseClosureReview }> {
    return this.db
      .transaction(() => {
        const review = this.inspect(input.runId)
        if (!review.canResolve) return { resolved: false, review }

        this.db
          .prepare(
            "UPDATE agent_runs SET status = 'completed', updated_at = ? WHERE run_id = ? AND status = 'handling_human'",
          )
          .run(input.now, input.runId)
        const resolvedBy = input.actor.customerId ?? input.actor.role
        this.db
          .prepare(
            `INSERT INTO agent_events (run_id, sequence, type, payload_json, created_at)
        SELECT ?, COALESCE(MAX(sequence), 0) + 1, 'run.resolved', ?, ? FROM agent_events WHERE run_id = ?`,
          )
          .run(
            input.runId,
            JSON.stringify({ summary: input.summary, resolvedBy }),
            input.now,
            input.runId,
          )
        this.db
          .prepare(
            `INSERT INTO audit_logs (occurred_at, actor_role, actor_id, action, resource_type, resource_id, detail_json, run_id)
        VALUES (?, ?, ?, 'run_resolved', 'run', ?, ?, ?)`,
          )
          .run(
            input.now,
            input.actor.role,
            resolvedBy,
            input.runId,
            JSON.stringify({ summary: input.summary, resolvedBy }),
            input.runId,
          )
        return {
          resolved: true,
          review: { ...review, status: 'completed' as const, canResolve: false },
        }
      })
      .immediate()
  }
}
