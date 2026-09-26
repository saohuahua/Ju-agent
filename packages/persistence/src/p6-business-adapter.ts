import type { SqliteDatabase } from './db.js'
import {
  compensationIdempotencyKey,
  priceProtectionIdempotencyKey,
  refundIdempotencyKey,
} from '@aftersales/contracts'
import {
  p6AfterSaleApprovalCommand,
  p6AfterSalePaymentApproval,
} from './p6-after-sale-repository.js'
import type { P6AfterSaleGuard } from './p6-after-sale-repository.js'
import type {
  P6CommandInput,
  P6ConfigSnapshot,
  P6Payment,
  P6PaymentResult,
  P6Task,
} from '../../contracts/src/p6-durable.js'

/**
 * 已建立的资金单映射到持久计划 此适配器不负责业务资格判断或创建售后单
 * 只接受既有领域流程已批准的补偿价保或已准备执行的退款
 */
const mappings = {
  compensation: {
    table: 'compensations',
    key: 'compensation_no',
    businessKey: compensationIdempotencyKey,
  },
  price_protection: {
    table: 'price_protections',
    key: 'protection_no',
    businessKey: priceProtectionIdempotencyKey,
  },
  refund: { table: 'refunds', key: 'refund_no', businessKey: refundIdempotencyKey },
} as const

type Kind = keyof typeof mappings
interface BusinessRow {
  resourceId: string
  customerId: string
  status: string
  amountCents: number
  currency: string
  requiresApproval: number
  returnNo?: string
  returnStatus?: string
  returnType?: string
  policyJson?: string
  refundKey?: string
  returnAmount?: number
  returnCurrency?: string
  refundOrder?: string
  returnOrder?: string
}

function readBusiness(db: SqliteDatabase, kind: Kind, resourceId: string): BusinessRow {
  const spec = mappings[kind]
  const row =
    kind === 'refund'
      ? db
          .prepare(
            `SELECT f.refund_no AS resourceId, r.customer_id AS customerId, f.status,
      f.amount_cents AS amountCents, f.currency, 0 AS requiresApproval, f.return_no AS returnNo,
      r.status AS returnStatus, r.type AS returnType, r.policy_decision_json AS policyJson,
      f.idempotency_key AS refundKey, r.refund_amount_cents AS returnAmount,
      r.currency AS returnCurrency, f.order_no AS refundOrder, r.order_no AS returnOrder
      FROM refunds f JOIN return_requests r ON r.return_no = f.return_no WHERE f.refund_no = ?`,
          )
          .get(resourceId)
      : db
          .prepare(
            `SELECT ${spec.key} AS resourceId, customer_id AS customerId, status,
      amount_cents AS amountCents, currency, requires_approval AS requiresApproval
      FROM ${spec.table} WHERE ${spec.key} = ?`,
          )
          .get(resourceId)
  if (!row) throw new Error('资金业务单不存在')
  const business = row as BusinessRow
  if (kind === 'refund') {
    if (
      business.returnType === 'exchange' ||
      business.refundKey !== refundIdempotencyKey(business.returnNo!) ||
      business.amountCents !== business.returnAmount ||
      business.currency !== business.returnCurrency ||
      business.refundOrder !== business.returnOrder
    )
      throw new Error('退款与原售后记录绑定冲突')
    const policy = JSON.parse(business.policyJson!) as { outcome?: unknown }
    if (policy.outcome !== 'allow' && policy.outcome !== 'needs_approval')
      throw new Error('退款政策尚未允许执行')
    business.requiresApproval = policy.outcome === 'needs_approval' ? 1 : 0
    if (
      !['auto_approved', 'approved', 'goods_received'].includes(business.returnStatus ?? '') ||
      (business.returnType !== 'refund_only' && business.returnStatus !== 'goods_received')
    ) {
      throw new Error('售后单未满足退款前置条件')
    }
  }
  return business
}

/** 调用方须在受理事务中使用 业务键由业务单生成 禁止使用运行编号生成资金键 */
export function p6ReadyPayment(
  db: SqliteDatabase,
  kind: Kind,
  resourceId: string,
  customerId: string,
): P6Payment {
  const row = readBusiness(db, kind, resourceId)
  if (row.customerId !== customerId) throw new Error('资金业务归属冲突')
  if (!(kind === 'refund' ? ['created'] : ['auto_approved', 'approved']).includes(row.status))
    throw new Error('业务未处于可执行状态')
  // 需要审批的单据必须通过专属桥接消费凭据 直接受理不能绕过审批
  if (row.requiresApproval) throw new Error('资金单必须通过审批桥接受理')
  return {
    businessKey: mappings[kind].businessKey(row.returnNo ?? resourceId),
    resourceId: `${kind}:${resourceId}`,
    amountCents: row.amountCents,
    currency: row.currency,
  }
}

/**
 * 桥接在仓储事务内调用 决定资源金额客户与最新断点必须全部一致
 * 凭据消费与持久命令同事务提交 后续重启依据命令授权 不二次消费令牌
 * 售后审批委托专属映射 退货换货只进入等待 收货由独立事务入口处理
 */
export function p6ApprovalCommand(
  db: SqliteDatabase,
  approvalId: string,
  config: P6ConfigSnapshot,
  afterSaleGuard?: P6AfterSaleGuard,
): P6CommandInput {
  const resource = db
    .prepare('SELECT resource_type AS type FROM approval_requests WHERE approval_id = ?')
    .get(approvalId) as { type: string } | undefined
  if (resource?.type === 'return_request')
    return p6AfterSaleApprovalCommand(db, approvalId, config, afterSaleGuard)
  const approval = db
    .prepare(
      `SELECT a.*, r.customer_id AS customerId, r.status AS runStatus,
    i.decision AS intentDecision FROM approval_requests a JOIN agent_runs r ON r.run_id = a.run_id
    JOIN approval_execution_intents i ON i.approval_id = a.approval_id WHERE a.approval_id = ?`,
    )
    .get(approvalId) as
    | {
        run_id: string
        resource_type: string
        resource_id: string
        amount_cents: number
        status: string
        one_time_token: string
        expires_at: string
        customerId: string
        runStatus: string
        intentDecision: string
      }
    | undefined
  if (
    !approval ||
    approval.status !== approval.intentDecision ||
    approval.runStatus !== 'awaiting_approval'
  ) {
    throw new Error('审批决定或运行状态不匹配')
  }
  if (approval.resource_type !== 'compensation' && approval.resource_type !== 'price_protection') {
    throw new Error('该审批需要领域流程准备可执行资金单')
  }
  const kind = approval.resource_type
  const business = readBusiness(db, kind, approval.resource_id)
  if (
    business.customerId !== approval.customerId ||
    business.amountCents !== approval.amount_cents ||
    business.status !== 'awaiting_approval'
  )
    throw new Error('审批业务绑定冲突')
  const checkpoint = db
    .prepare(
      `SELECT state_json AS state FROM checkpoints WHERE run_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(approval.run_id) as { state: string } | undefined
  const state = checkpoint ? (JSON.parse(checkpoint.state) as Record<string, unknown>) : undefined
  const numberKey = kind === 'compensation' ? 'compensationNo' : 'protectionNo'
  const amountKey = kind === 'compensation' ? 'amountCents' : 'refundAmountCents'
  if (
    state?.approvalId !== approvalId ||
    state[numberKey] !== approval.resource_id ||
    state.approvalResourceType !== kind ||
    state[amountKey] !== approval.amount_cents
  )
    throw new Error('审批检查点绑定冲突')
  const spec = mappings[kind]
  const now = new Date().toISOString()
  const approved = approval.status === 'approved'
  if (approved) {
    const consumed = db
      .prepare(
        `UPDATE approval_requests SET one_time_token = '' WHERE approval_id = ?
      AND status = 'approved' AND one_time_token <> '' AND expires_at > ?`,
      )
      .run(approvalId, now)
    if (consumed.changes !== 1) throw new Error('审批凭据已消费或过期')
  }
  db.prepare(
    `UPDATE ${spec.table} SET status = ?, version = version + 1, updated_at = ? WHERE ${spec.key} = ?`,
  ).run(approved ? 'approved' : 'rejected', now, approval.resource_id)
  return {
    requestKey: `approval:${approvalId}`,
    kind: 'approval',
    approvalId,
    runId: approval.run_id,
    customerId: approval.customerId,
    config,
    plan: {
      input: approved ? '执行已批准方案' : '记录已拒绝方案',
      tool: kind,
      ...(approved
        ? {
            payment: {
              businessKey: spec.businessKey(approval.resource_id),
              resourceId: `${kind}:${approval.resource_id}`,
              amountCents: business.amountCents,
              currency: business.currency,
            },
          }
        : {}),
    },
  }
}

/**
 * 资金发送前在同一个围栏事务内重查业务并标记执行中
 * 人工已取消或金额被改写时禁止发送 大额授权只能来自该任务绑定的已消费审批
 */
export function p6PrepareBusinessPayment(
  db: SqliteDatabase,
  payment: P6Payment,
  task: P6Task,
): void {
  const split = payment.resourceId.indexOf(':')
  const kind = payment.resourceId.slice(0, split) as Kind
  const resourceId = payment.resourceId.slice(split + 1)
  if (!Object.hasOwn(mappings, kind)) throw new Error('未知资金业务类型')
  const row = readBusiness(db, kind, resourceId)
  if (
    row.customerId !== task.customerId ||
    row.amountCents !== payment.amountCents ||
    row.currency !== payment.currency ||
    payment.businessKey !== mappings[kind].businessKey(row.returnNo ?? resourceId)
  )
    throw new Error('资金计划绑定冲突')
  if (!(kind === 'refund' ? ['created'] : ['auto_approved', 'approved']).includes(row.status))
    throw new Error('业务已不允许执行')
  if (row.requiresApproval) {
    // 售后收货任务引用原审批任务 不重复占用审批任务的唯一关联
    const approvalId =
      kind === 'refund' ? p6AfterSalePaymentApproval(db, payment, task) : task.approvalId
    const valid = db
      .prepare(
        `SELECT 1 FROM approval_requests WHERE approval_id = ? AND run_id = ?
      AND resource_type = ? AND resource_id = ? AND amount_cents = ? AND status = 'approved' AND one_time_token = ''`,
      )
      .get(
        approvalId,
        task.runId,
        kind === 'refund' ? 'return_request' : kind,
        row.returnNo ?? resourceId,
        payment.amountCents,
      )
    if (!valid) throw new Error('资金计划缺少已受理审批授权')
  }
  const spec = mappings[kind]
  // 正式组合根须在本次围栏事务调用执行权守卫后才能进入执行中
  db.prepare(
    `UPDATE ${spec.table} SET status = 'executing', version = version + 1, updated_at = ? WHERE ${spec.key} = ?`,
  ).run(new Date().toISOString(), resourceId)
  if (kind === 'refund')
    db.prepare('UPDATE refunds SET attempts = attempts + 1 WHERE refund_no = ?').run(resourceId)
}

/**
 * 仅在租约围栏与渠道确认之后回写现有业务表 幂等结果和审计处于同一事务
 * 未知结果不进入本函数的成功分支 保留原单据并由持久任务阻止错误终结
 */
export function p6ApplyBusinessPayment(
  db: SqliteDatabase,
  payment: P6Payment,
  result: P6PaymentResult,
): void {
  if (result.status !== 'succeeded' && result.status !== 'rejected')
    throw new Error('资金终态未确认')
  const split = payment.resourceId.indexOf(':')
  const kind = payment.resourceId.slice(0, split) as Kind
  const resourceId = payment.resourceId.slice(split + 1)
  if (!Object.hasOwn(mappings, kind)) throw new Error('未知资金业务类型')
  const spec = mappings[kind]
  const row = readBusiness(db, kind, resourceId)
  if (
    row.amountCents !== payment.amountCents ||
    row.currency !== payment.currency ||
    payment.businessKey !== spec.businessKey(row.returnNo ?? resourceId)
  )
    throw new Error('资金回写绑定冲突')
  if (row.status !== 'executing') throw new Error('资金业务状态冲突')
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE ${spec.table} SET status = ?, version = version + 1, updated_at = ? WHERE ${spec.key} = ?`,
  ).run(result.status === 'succeeded' ? 'succeeded' : 'failed', now, resourceId)
  if (result.status === 'succeeded') {
    db.prepare(`INSERT INTO idempotency_records(key,result_json,created_at) VALUES (?,?,?)`).run(
      payment.businessKey,
      JSON.stringify({ ...payment, gatewayRefundId: result.transactionId }),
      now,
    )
    if (kind === 'refund') {
      db.prepare(
        `UPDATE return_requests SET status = 'completed', version = version + 1, updated_at = ?
        WHERE return_no = ?`,
      ).run(now, row.returnNo)
    }
  }
  db.prepare(
    `INSERT INTO audit_logs(occurred_at,actor_role,actor_id,action,resource_type,resource_id,detail_json)
    VALUES (?,'system','p6-worker','p6_payment_confirmed',?,?,?)`,
  ).run(now, kind, resourceId, JSON.stringify(result))
}
