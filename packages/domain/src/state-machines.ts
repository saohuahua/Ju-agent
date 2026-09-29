/**
 * 确定性状态机
 *
 * 领域服务在改状态前调用迁移检查 持久仓储另有条件 SQL 路径
 * 本模块只判断迁移与抛错 不负责保存记录或写入审计
 */

import {
  APPROVAL_TRANSITIONS,
  COMPENSATION_TRANSITIONS,
  PRICE_PROTECTION_TRANSITIONS,
  REFUND_TRANSITIONS,
  RETURN_TRANSITIONS,
  RUN_TRANSITIONS,
  type ApprovalStatus,
  type CompensationStatus,
  type PriceProtectionStatus,
  type RefundStatus,
  type ReturnStatus,
  type RunStatus,
} from '@aftersales/contracts'

export class IllegalTransitionError extends Error {
  constructor(
    public readonly entity: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`非法状态迁移 ${entity} ${from} -> ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>

function assertTransition<S extends string>(
  entity: string,
  table: TransitionTable<S>,
  from: S,
  to: S,
): void {
  // 只允许进入当前状态列出的目标 不根据状态名称相近自动放行
  const allowed = table[from]
  if (!allowed || !allowed.includes(to)) {
    throw new IllegalTransitionError(entity, from, to)
  }
}

/** 检查会话交互状态 不代表售后与资金已经完成 */
export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  assertTransition('AgentRun', RUN_TRANSITIONS, from, to)
}

/** 检查售后流程边 归属 原授权与动作条件仍由调用方核验 */
export function assertReturnTransition(from: ReturnStatus, to: ReturnStatus): void {
  assertTransition('ReturnRequest', RETURN_TRANSITIONS, from, to)
}

/** 检查退款迁移 不能替代渠道结果和资金执行权核验 */
export function assertRefundTransition(from: RefundStatus, to: RefundStatus): void {
  assertTransition('Refund', REFUND_TRANSITIONS, from, to)
}

/** 检查审批迁移 不允许已拒绝审批再改为批准 */
export function assertApprovalTransition(from: ApprovalStatus, to: ApprovalStatus): void {
  assertTransition('Approval', APPROVAL_TRANSITIONS, from, to)
}

/** 补偿使用独立迁移表 避免套用退款的结束条件 */
export function assertCompensationTransition(
  from: CompensationStatus,
  to: CompensationStatus,
): void {
  assertTransition('Compensation', COMPENSATION_TRANSITIONS, from, to)
}

/** 价保使用独立生命周期 差价方案仍须单独验证 */
export function assertPriceProtectionTransition(
  from: PriceProtectionStatus,
  to: PriceProtectionStatus,
): void {
  assertTransition('PriceProtection', PRICE_PROTECTION_TRANSITIONS, from, to)
}

/** 只读判断迁移是否合法 不取得写入许可也不阻止并发改变状态 */
export function canTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  const allowed = table[from]
  return Boolean(allowed?.includes(to))
}
