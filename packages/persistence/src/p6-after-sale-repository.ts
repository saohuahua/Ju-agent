import { refundIdempotencyKey, receiveGoodsIdempotencyKey } from '@aftersales/contracts'
import type { ReturnStatus, ReturnType } from '@aftersales/contracts'
import { assertReturnTransition, assertRefundTransition } from '@aftersales/domain'
import type {
  P6AfterSaleGuardContext,
  P6AfterSaleReceipt,
} from '../../contracts/src/p6-after-sale-mapping.js'
import type {
  P6CommandInput,
  P6ConfigSnapshot,
  P6Payment,
  P6Task,
} from '../../contracts/src/p6-durable.js'
import type { SqliteDatabase } from './db.js'
import { P6TaskRepository } from './p6-task-repository.js'

export type P6AfterSaleGuard = (db: SqliteDatabase, context: P6AfterSaleGuardContext) => void

interface Binding {
  approvalId: string
  runId: string
  customerId: string
  runStatus: string
  returnNo: string
  type: ReturnType
  status: ReturnStatus
  amount: number
  currency: string
  approvalStatus: string
  token: string
  expires: string
  policy: string
  intentStatus: string | null
  intentDecision: string | null
  intentRun: string | null
  refundNo: string | null
  refundStatus: string | null
  refundAmount: number | null
  refundCurrency: string | null
  refundKey: string | null
  orderNo: string
  refundOrder: string | null
}

/** 所有绑定读取使用同库连接 损坏或不完整的最新断点直接阻断操作 */
function binding(db: SqliteDatabase, approvalId: string): Binding {
  const row = db
    .prepare(
      `SELECT a.approval_id AS approvalId, a.run_id AS runId,
    r.customer_id AS customerId, r.status AS runStatus, b.return_no AS returnNo,
    b.type, b.status, b.refund_amount_cents AS amount, b.currency, b.order_no AS orderNo,
    b.policy_decision_json AS policy, a.status AS approvalStatus, a.one_time_token AS token,
    a.expires_at AS expires, i.status AS intentStatus, i.decision AS intentDecision,
    i.run_id AS intentRun, f.refund_no AS refundNo, f.status AS refundStatus,
    f.amount_cents AS refundAmount, f.currency AS refundCurrency,
    f.idempotency_key AS refundKey, f.order_no AS refundOrder
    FROM approval_requests a JOIN agent_runs r ON r.run_id = a.run_id
    JOIN return_requests b ON b.return_no = a.resource_id AND b.customer_id = r.customer_id
      AND b.refund_amount_cents = a.amount_cents
    LEFT JOIN approval_execution_intents i ON i.approval_id = a.approval_id
    LEFT JOIN refunds f ON f.return_no = b.return_no
    WHERE a.approval_id = ? AND a.resource_type = 'return_request'`,
    )
    .get(approvalId) as Binding | undefined
  if (!row || !['refund_only', 'return', 'exchange'].includes(row.type))
    throw new Error('售后审批业务绑定冲突')
  if (JSON.parse(row.policy)?.outcome !== 'needs_approval') throw new Error('售后审批政策冲突')
  if (!Number.isSafeInteger(row.amount) || row.amount < 0 || !row.currency)
    throw new Error('售后审批金额无效')
  if (row.type === 'exchange') {
    // 原政策对换货仍保留商品金额 该金额只用于审批核对
    if (row.refundNo !== null) throw new Error('换货不得关联资金记录')
  } else if (
    !row.refundNo ||
    row.amount <= 0 ||
    row.refundAmount !== row.amount ||
    row.refundCurrency !== row.currency ||
    row.refundOrder !== row.orderNo ||
    row.refundKey !== refundIdempotencyKey(row.returnNo)
  ) {
    throw new Error('原退款记录绑定冲突')
  }
  if (
    row.intentStatus &&
    (row.intentRun !== row.runId || row.intentDecision !== row.approvalStatus)
  )
    throw new Error('售后审批意图绑定冲突')
  return row
}

function checkpoint(db: SqliteDatabase, row: Binding, checkToken: boolean): void {
  const saved = db
    .prepare(
      'SELECT state_json AS state FROM checkpoints WHERE run_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(row.runId) as { state: string } | undefined
  const state = saved ? (JSON.parse(saved.state) as Record<string, unknown> | null) : null
  if (
    !state ||
    state.approvalId !== row.approvalId ||
    state.returnNo !== row.returnNo ||
    state.approvalResourceType !== 'return_request' ||
    state.refundAmountCents !== row.amount ||
    state.refundNo !== row.refundNo ||
    state.policyOutcome !== 'needs_approval' ||
    state.requiresApproval !== true ||
    (checkToken && (!row.token || state.approvalToken !== row.token))
  )
    throw new Error('售后审批最新断点绑定冲突')
}

/** 守卫缺失或返回异步结果一律阻断 不允许跨越事务提交边界 */
function guard(
  db: SqliteDatabase,
  row: Binding,
  phase: P6AfterSaleGuardContext['phase'],
  hook?: P6AfterSaleGuard,
): void {
  if (!db.inTransaction) throw new Error('售后映射必须处于同库事务')
  if (!hook) throw new Error('售后映射缺少执行权守卫')
  const result: unknown = hook(db, {
    approvalId: row.approvalId,
    runId: row.runId,
    customerId: row.customerId,
    returnNo: row.returnNo,
    phase,
    ...(row.type === 'exchange' ? {} : { businessKey: refundIdempotencyKey(row.returnNo) }),
  })
  if (result !== undefined) throw new Error('执行权守卫必须同步且无返回值')
}

function move(db: SqliteDatabase, row: Binding, target: ReturnStatus, now: string): void {
  assertReturnTransition(row.status, target)
  const changed = db
    .prepare(
      `UPDATE return_requests SET status = ?, version = version + 1,
    updated_at = ? WHERE return_no = ? AND status = ?`,
    )
    .run(target, now, row.returnNo, row.status)
  if (changed.changes !== 1) throw new Error('售后状态竞争冲突')
  row.status = target
}

function audit(db: SqliteDatabase, row: Binding, action: string, now: string): void {
  db.prepare(
    `INSERT INTO audit_logs
    (occurred_at,actor_role,actor_id,action,resource_type,resource_id,detail_json,run_id)
    VALUES (?,'system','p6-after-sale',?,'return_request',?,'{}',?)`,
  ).run(now, action, row.returnNo, row.runId)
}

function payment(row: Binding): P6Payment {
  if (row.type === 'exchange' || !row.refundNo || row.refundStatus !== 'created')
    throw new Error('售后单没有可受理的原退款')
  return {
    businessKey: refundIdempotencyKey(row.returnNo),
    resourceId: `refund:${row.refundNo}`,
    amountCents: row.refundAmount!,
    currency: row.refundCurrency!,
  }
}

/** 审批桥接回调只能在受理事务内部调用 失败由外层回滚令牌业务与命令 */
export function p6AfterSaleApprovalCommand(
  db: SqliteDatabase,
  approvalId: string,
  config: P6ConfigSnapshot,
  hook?: P6AfterSaleGuard,
  now = new Date().toISOString(),
): P6CommandInput {
  const row = binding(db, approvalId)
  checkpoint(db, row, true)
  if (
    row.runStatus !== 'awaiting_approval' ||
    row.status !== 'awaiting_approval' ||
    row.intentStatus !== 'pending' ||
    !['approved', 'rejected'].includes(row.approvalStatus)
  )
    throw new Error('售后审批尚不可映射或已被认领')
  if (row.refundNo && row.refundStatus !== 'created') throw new Error('退款记录已被执行或终止')
  const approved = row.approvalStatus === 'approved'
  if (approved && !(Date.parse(row.expires) > Date.parse(now)))
    throw new Error('售后审批已过期 请调用过期终止入口')

  // 执行权接入点必须先于令牌消费并与受理共用当前事务
  guard(db, row, 'approval', hook)
  const consumed = db
    .prepare(
      `UPDATE approval_requests SET one_time_token = ''
    WHERE approval_id = ? AND status = ? AND one_time_token = ?`,
    )
    .run(approvalId, row.approvalStatus, row.token)
  if (consumed.changes !== 1) throw new Error('售后审批凭据竞争冲突')
  move(db, row, approved ? 'approved' : 'rejected', now)
  if (approved && row.type !== 'refund_only') move(db, row, 'awaiting_buyer_shipment', now)
  if (!approved) cancelRefund(db, row, now)
  audit(db, row, approved ? 'approval_approved' : 'approval_rejected', now)
  return {
    requestKey: `approval:${approvalId}`,
    kind: 'approval',
    approvalId,
    runId: row.runId,
    customerId: row.customerId,
    config,
    requestPayload: {
      returnNo: row.returnNo,
      refundNo: row.refundNo,
      decision: row.approvalStatus,
      amountCents: row.amount,
      currency: row.currency,
      type: row.type,
    },
    plan: {
      input: !approved
        ? '记录已拒绝售后方案'
        : row.type === 'refund_only'
          ? '执行已批准退款'
          : '等待买家寄回',
      tool: approved && row.type !== 'refund_only' ? 'after_sale_wait' : 'return_request',
      ...(approved && row.type === 'refund_only' ? { payment: payment(row) } : {}),
    },
  }
}

function cancelRefund(db: SqliteDatabase, row: Binding, now: string): void {
  if (!row.refundNo) return
  if (row.refundStatus !== 'created') throw new Error('不能终止已执行的退款')
  assertRefundTransition('created', 'cancelled')
  db.prepare(
    `UPDATE refunds SET status = 'cancelled', version = version + 1, updated_at = ?
    WHERE refund_no = ? AND status = 'created'`,
  ).run(now, row.refundNo)
}

/** 独立组合根使用此仓储 只受理明确指定的售后资源 不启动扫描或支付 */
export class P6AfterSaleRepository {
  private readonly tasks: P6TaskRepository
  constructor(
    private readonly db: SqliteDatabase,
    private readonly hook: P6AfterSaleGuard,
    private readonly now = Date.now,
  ) {
    this.tasks = new P6TaskRepository(db, now)
  }

  /** 已持久受理直接返回原任务 历史运行中意图没有原命令时拒绝接管 */
  acceptApproval(approvalId: string, config: P6ConfigSnapshot): P6Task {
    return this.db
      .transaction(() => {
        const row = binding(this.db, approvalId)
        const existing = this.tasks.findRequest(row.customerId, `approval:${approvalId}`)
        if (existing) {
          assertOriginal(existing, row)
          return existing
        }
        const input = p6AfterSaleApprovalCommand(
          this.db,
          approvalId,
          config,
          this.hook,
          new Date(this.now()).toISOString(),
        )
        const task = this.tasks.accept(input)
        this.db
          .prepare(
            `UPDATE approval_execution_intents SET status = 'running', updated_at = ?
        WHERE approval_id = ? AND status = 'pending'`,
          )
          .run(new Date(this.now()).toISOString(), approvalId)
        return task
      })
      .immediate()
  }

  /** 过期只终止未接管审批 已消费授权不能被时间扫描撤销 历史运行中意图交人工核验 */
  expireApproval(approvalId: string): void {
    this.db
      .transaction(() => {
        const row = binding(this.db, approvalId)
        if (
          row.status === 'expired' &&
          !row.token &&
          (!row.refundNo || row.refundStatus === 'cancelled')
        )
          return
        checkpoint(this.db, row, true)
        const now = new Date(this.now()).toISOString()
        if (
          row.status !== 'awaiting_approval' ||
          row.runStatus !== 'awaiting_approval' ||
          !['pending', 'approved', 'expired'].includes(row.approvalStatus) ||
          (row.approvalStatus !== 'expired' && !(Date.parse(row.expires) <= this.now())) ||
          (row.intentStatus !== null && row.intentStatus !== 'pending')
        )
          throw new Error('售后审批不能按过期终止')
        guard(this.db, row, 'expiry', this.hook)
        // 已批准事实保持不变 只清除尚未消费的授权并终止业务
        this.db
          .prepare(
            `UPDATE approval_requests SET one_time_token = '',
        status = CASE WHEN status = 'pending' THEN 'expired' ELSE status END WHERE approval_id = ?`,
          )
          .run(approvalId)
        move(this.db, row, 'expired', now)
        cancelRefund(this.db, row, now)
        this.db
          .prepare(
            `UPDATE approval_execution_intents SET status = 'failed', last_error = 'approval_expired',
        updated_at = ? WHERE approval_id = ? AND status = 'pending'`,
          )
          .run(now, approvalId)
        audit(this.db, row, 'approval_expired', now)
      })
      .immediate()
  }

  /** 仓储确认收货与退款受理共用事务 不调用会立即付款的旧收货服务 */
  receive(input: P6AfterSaleReceipt): P6Task {
    return this.db
      .transaction(() => {
        const row = binding(this.db, input.approvalId)
        if (
          row.returnNo !== input.returnNo ||
          row.runId !== input.runId ||
          row.customerId !== input.customerId ||
          row.type === 'refund_only' ||
          row.approvalStatus !== 'approved' ||
          row.token
        )
          throw new Error('收货审批归属或授权冲突')
        const authorization = this.tasks.findRequest(row.customerId, `approval:${row.approvalId}`)
        if (authorization) assertOriginal(authorization, row)
        if (
          !authorization ||
          authorization.runId !== row.runId ||
          authorization.approvalId !== row.approvalId ||
          !['queued', 'running', 'completed'].includes(authorization.status) ||
          authorization.input.plan.tool !== 'after_sale_wait' ||
          authorization.input.plan.payment ||
          authorization.input.requestPayload?.returnNo !== row.returnNo ||
          authorization.input.requestPayload?.refundNo !== row.refundNo ||
          authorization.input.requestPayload?.decision !== 'approved'
        )
          throw new Error('收货缺少持久审批授权')
        const requestKey = receiveGoodsIdempotencyKey(row.returnNo)
        const existing = this.tasks.findRequest(row.customerId, requestKey)
        if (existing) {
          if (
            existing.runId !== row.runId ||
            existing.input.requestPayload?.approvalId !== row.approvalId ||
            existing.input.requestPayload?.returnNo !== row.returnNo ||
            existing.input.requestPayload?.action !== 'receive_goods'
          )
            throw new Error('原收货命令绑定冲突')
          return existing
        }
        checkpoint(this.db, row, false)
        if (row.status !== 'buyer_shipped') throw new Error('必须先登记买家寄回才能确认收货')
        if (row.refundNo && row.refundStatus !== 'created') throw new Error('原退款已被执行或终止')

        // 执行权接入点核验原资源归属 收货状态与后续命令必须一同提交
        guard(this.db, row, 'receipt', this.hook)
        const now = new Date(this.now()).toISOString()
        move(this.db, row, 'goods_received', now)
        audit(this.db, row, 'return_goods_received', now)
        if (row.type === 'exchange') {
          move(this.db, row, 'completed', now)
          audit(this.db, row, 'exchange_completed', now)
        }
        return this.tasks.accept({
          // 审批任务占用唯一审批关联 收货命令通过受校验的载荷引用原授权
          requestKey,
          kind: 'message',
          runId: row.runId,
          customerId: row.customerId,
          config: authorization.input.config,
          requestPayload: {
            returnNo: row.returnNo,
            approvalId: row.approvalId,
            action: 'receive_goods',
          },
          plan: {
            input: row.type === 'exchange' ? '记录换货收货完结' : '执行收货后退款',
            tool: 'return_request',
            ...(row.type === 'exchange' ? {} : { payment: payment(row) }),
          },
        })
      })
      .immediate()
  }
}

/** 重试只复用本映射形成的不可变授权 防止同键其他命令或等待期间业务篡改 */
function assertOriginal(task: P6Task, row: Binding): void {
  const payload = task.input.requestPayload
  if (
    task.runId !== row.runId ||
    task.approvalId !== row.approvalId ||
    task.input.kind !== 'approval' ||
    payload?.returnNo !== row.returnNo ||
    payload.refundNo !== row.refundNo ||
    payload.amountCents !== row.amount ||
    payload.currency !== row.currency ||
    payload.type !== row.type ||
    payload.decision !== row.approvalStatus ||
    row.token
  )
    throw new Error('原持久审批命令绑定冲突')
}

/** 发送前从已落库命令追溯原审批 收货命令不能凭空提供审批编号扩大授权 */
export function p6AfterSalePaymentApproval(
  db: SqliteDatabase,
  payment: P6Payment,
  task: P6Task,
): string {
  const approvalId = task.approvalId ?? task.input.requestPayload?.approvalId
  if (typeof approvalId !== 'string') throw new Error('退款任务缺少原审批引用')
  const row = binding(db, approvalId)
  const tasks = new P6TaskRepository(db)
  const original = tasks.findRequest(row.customerId, `approval:${approvalId}`)
  if (!original) throw new Error('退款缺少原持久授权')
  assertOriginal(original, row)
  if (!['queued', 'running', 'completed'].includes(original.status))
    throw new Error('原审批任务已终止或需要人工核验')
  if (
    row.approvalStatus !== 'approved' ||
    task.customerId !== row.customerId ||
    task.runId !== row.runId ||
    payment.businessKey !== refundIdempotencyKey(row.returnNo) ||
    payment.resourceId !== `refund:${row.refundNo}` ||
    payment.amountCents !== row.amount ||
    payment.currency !== row.currency
  )
    throw new Error('退款任务与持久授权冲突')
  if (task.approvalId) {
    if (task.taskId !== original.taskId || row.type !== 'refund_only')
      throw new Error('非直接退款审批任务')
  } else {
    const receipt = tasks.findRequest(row.customerId, receiveGoodsIdempotencyKey(row.returnNo))
    if (
      row.type !== 'return' ||
      row.status !== 'goods_received' ||
      receipt?.taskId !== task.taskId ||
      receipt.input.requestPayload?.approvalId !== approvalId ||
      receipt.input.requestPayload?.returnNo !== row.returnNo ||
      receipt.input.requestPayload?.action !== 'receive_goods'
    )
      throw new Error('退款缺少原收货命令')
  }
  return approvalId
}
