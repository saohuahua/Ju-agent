/**
 * 领域枚举与状态迁移表
 *
 * 本文件是整个系统的单一事实来源
 * 所有状态只能通过 domain 包的状态机函数迁移 迁移表在这里集中声明
 * 修改任何枚举值都属于破坏性契约变更 必须同步更新评测期望与前端展示
 */

import { z } from 'zod'

/** 售后会话运行状态 Agent 循环与工作流共同驱动 */
export const RUN_STATUSES = [
  'created',
  'running',
  'awaiting_input',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'escalated',
] as const
export const RunStatus = z.enum(RUN_STATUSES)
export type RunStatus = z.infer<typeof RunStatus>

/** 售后单状态 审批与退货物流交织的确定性状态机 */
export const RETURN_STATUSES = [
  'submitted',
  'auto_approved',
  'awaiting_approval',
  'approved',
  'rejected',
  'expired',
  'awaiting_buyer_shipment',
  'buyer_shipped',
  'goods_received',
  'completed',
  'failed',
  'cancelled',
] as const
export const ReturnStatus = z.enum(RETURN_STATUSES)
export type ReturnStatus = z.infer<typeof ReturnStatus>

/** 退款单状态 created 到 executing 之间由审批环节把关 */
export const REFUND_STATUSES = ['created', 'executing', 'succeeded', 'failed', 'cancelled'] as const
export const RefundStatus = z.enum(REFUND_STATUSES)
export type RefundStatus = z.infer<typeof RefundStatus>

/** 审批请求状态 一次性令牌 只允许一次有效决定 */
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const
export const ApprovalStatus = z.enum(APPROVAL_STATUSES)
export type ApprovalStatus = z.infer<typeof ApprovalStatus>

/** 工具风险等级 高风险工具必须经过审批且幂等 */
export const RISK_LEVELS = ['low', 'medium', 'high'] as const
export const RiskLevel = z.enum(RISK_LEVELS)
export type RiskLevel = z.infer<typeof RiskLevel>

/** Agent 可识别的业务意图 意图决定走哪条确定性工作流 */
export const INTENTS = [
  'query_order',
  'submit_return',
  'submit_refund_only',
  'submit_exchange',
  'cancel_return',
  'compensation',
  'escalate',
] as const
export const Intent = z.enum(INTENTS)
export type Intent = z.infer<typeof Intent>

/**
 * 补偿原因 有限集合保证同订单同原因的幂等拦截可比较
 * 扩展新原因需同步评测用例与提示词描述
 */
export const COMPENSATION_REASONS = ['late_delivery', 'service_apology'] as const
export const CompensationReason = z.enum(COMPENSATION_REASONS)
export type CompensationReason = z.infer<typeof CompensationReason>

/** 补偿单状态 分级审批与执行交织的确定性状态机 */
export const COMPENSATION_STATUSES = [
  'created',
  'auto_approved',
  'awaiting_approval',
  'approved',
  'rejected',
  'expired',
  'executing',
  'succeeded',
  'failed',
  'cancelled',
] as const
export const CompensationStatus = z.enum(COMPENSATION_STATUSES)
export type CompensationStatus = z.infer<typeof CompensationStatus>

/** 售后类型 退货退款 走物流 仅退款 不走物流 换货 */
export const RETURN_TYPES = ['return', 'refund_only', 'exchange'] as const
export const ReturnType = z.enum(RETURN_TYPES)
export type ReturnType = z.infer<typeof ReturnType>

/** 售后原因 影响政策判定 */
export const RETURN_REASONS = [
  'no_reason',
  'quality',
  'damaged',
  'wrong_item',
  'lost_package',
  'unshipped_cancel',
] as const
export const ReturnReason = z.enum(RETURN_REASONS)
export type ReturnReason = z.infer<typeof ReturnReason>

/** 物流推送事件状态 仅覆盖需要主动触达的恶化状态 已签收订单拒绝注入 */
export const LOGISTICS_EVENT_STATUSES = ['delayed', 'lost'] as const
export const LogisticsEventStatus = z.enum(LOGISTICS_EVENT_STATUSES)
export type LogisticsEventStatus = z.infer<typeof LogisticsEventStatus>

/** 统一错误分类 工具层 投射到用户可理解的解释 */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'AUTHORIZATION_DENIED',
  'POLICY_DENIED',
  'APPROVAL_REQUIRED',
  'APPROVAL_TOKEN_INVALID',
  'APPROVAL_EXPIRED',
  'CONFLICT',
  'RATE_LIMITED',
  'TIMEOUT',
  'UPSTREAM_ERROR',
  'IDEMPOTENT_REPLAY',
  'INTERNAL_ERROR',
] as const
export const ErrorCode = z.enum(ERROR_CODES)
export type ErrorCode = z.infer<typeof ErrorCode>

/** SSE 事件类型 每个事件的 payload 在 events.ts 中定义 */
export const EVENT_TYPES = [
  'run.started',
  'message.user',
  'message.delta',
  'message.completed',
  'agent.output',
  'agent.turn',
  'agent.tool_results',
  'tool.input.delta',
  'context.compacted',
  'step.started',
  'step.completed',
  'tool.requested',
  'tool.completed',
  'approval.required',
  'approval.decided',
  'run.paused',
  'run.resumed',
  'run.failed',
  'run.completed',
  'run.escalated',
  'logistics.event',
] as const
export const EventType = z.enum(EVENT_TYPES)
export type EventType = z.infer<typeof EventType>

/**
 * 状态迁移表 value 为允许迁往的目标状态集合
 * domain 包的 assertTransition 是唯一执行入口
 */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  created: ['running', 'cancelled'],
  running: ['awaiting_input', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'escalated'],
  awaiting_input: ['running', 'cancelled'],
  awaiting_approval: ['running', 'completed', 'escalated', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  escalated: [],
}

export const RETURN_TRANSITIONS: Readonly<Record<ReturnStatus, readonly ReturnStatus[]>> = {
  submitted: ['auto_approved', 'awaiting_approval', 'rejected', 'cancelled'],
  auto_approved: ['awaiting_buyer_shipment', 'completed', 'failed', 'cancelled'],
  awaiting_approval: ['approved', 'rejected', 'expired', 'cancelled'],
  approved: ['awaiting_buyer_shipment', 'completed', 'failed', 'cancelled'],
  rejected: [],
  expired: [],
  awaiting_buyer_shipment: ['buyer_shipped', 'cancelled'],
  buyer_shipped: ['goods_received', 'failed', 'cancelled'],
  goods_received: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: ['completed', 'cancelled'],
  cancelled: [],
}

export const REFUND_TRANSITIONS: Readonly<Record<RefundStatus, readonly RefundStatus[]>> = {
  created: ['executing', 'cancelled'],
  executing: ['succeeded', 'failed'],
  succeeded: [],
  failed: ['executing', 'cancelled'],
  cancelled: [],
}

export const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: [],
  rejected: [],
  expired: [],
}

export const COMPENSATION_TRANSITIONS: Readonly<Record<CompensationStatus, readonly CompensationStatus[]>> = {
  created: ['auto_approved', 'awaiting_approval', 'cancelled'],
  auto_approved: ['executing', 'cancelled'],
  awaiting_approval: ['approved', 'rejected', 'expired', 'cancelled'],
  approved: ['executing', 'cancelled'],
  rejected: [],
  expired: [],
  executing: ['succeeded', 'failed'],
  succeeded: [],
  failed: ['executing', 'cancelled'],
  cancelled: [],
}
