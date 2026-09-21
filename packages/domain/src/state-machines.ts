/**
 * 确定性状态机
 *
 * 所有实体状态迁移必须经过 assertTransition
 * 非法迁移直接抛错并留审计 不存在静默兜底
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
  const allowed = table[from]
  if (!allowed || !allowed.includes(to)) {
    throw new IllegalTransitionError(entity, from, to)
  }
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  assertTransition('AgentRun', RUN_TRANSITIONS, from, to)
}

export function assertReturnTransition(from: ReturnStatus, to: ReturnStatus): void {
  assertTransition('ReturnRequest', RETURN_TRANSITIONS, from, to)
}

export function assertRefundTransition(from: RefundStatus, to: RefundStatus): void {
  assertTransition('Refund', REFUND_TRANSITIONS, from, to)
}

export function assertApprovalTransition(from: ApprovalStatus, to: ApprovalStatus): void {
  assertTransition('Approval', APPROVAL_TRANSITIONS, from, to)
}

export function assertCompensationTransition(
  from: CompensationStatus,
  to: CompensationStatus,
): void {
  assertTransition('Compensation', COMPENSATION_TRANSITIONS, from, to)
}

export function assertPriceProtectionTransition(
  from: PriceProtectionStatus,
  to: PriceProtectionStatus,
): void {
  assertTransition('PriceProtection', PRICE_PROTECTION_TRANSITIONS, from, to)
}

/** 判断迁移是否合法 供工作流做前置检查而不抛错 */
export function canTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  const allowed = table[from]
  return Boolean(allowed?.includes(to))
}
