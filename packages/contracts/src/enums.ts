/**
 * 领域枚举与状态迁移表
 *
 * 本文件是整个系统的单一事实来源
 * 所有状态只能通过 domain 包的状态机函数迁移 迁移表在这里集中声明
 * 修改任何枚举值都属于破坏性契约变更 必须同步更新评测期望与前端展示
 */

import { z } from 'zod'

/** 售后会话运行状态 Agent 循环与工作流共同驱动 escalated 后可转人工坐席处理 */
export const RUN_STATUSES = [
  'created',
  'running',
  'awaiting_input',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'escalated',
  'handling_human',
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
  'price_protection',
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

/**
 * 副作用防线层级 三道闸串联 任一拦截即不产生资金动作
 *
 * idempotency    业务幂等键 同键重放直接返回首次结果
 * approval_token 一次性审批令牌 同一令牌只接受一次有效决定
 * gateway        支付网关级去重 最后一道兜底 防止前两道被绕过
 */
export const GUARD_LAYERS = ['idempotency', 'approval_token', 'gateway'] as const
export const GuardLayer = z.enum(GUARD_LAYERS)
export type GuardLayer = z.infer<typeof GuardLayer>

/**
 * 工具目录变更原因 能力门控的状态说明 供前端渲染稳定文案
 *
 * initial      会话起始目录 未查过订单 动作工具不暴露给模型
 * order_loaded 订单已载入 动作工具解禁进入目录
 */
export const TOOL_GATE_REASONS = ['initial', 'order_loaded'] as const
export const ToolGateReason = z.enum(TOOL_GATE_REASONS)
export type ToolGateReason = z.infer<typeof ToolGateReason>

/**
 * 越权诉求的两类分流 v2.2 把两者混为一谈是 injection_defense 从 40% 掉到 7.7% 的根因
 *
 * out_of_scope      正当诉求但超出本 Agent 能力范围
 *                   如代他人办理 要求线下转账 要求改价
 *                   处置 如实拒绝 说明原因与替代路径 然后 conclude 收尾 不升级
 *                   误升级这类诉求会把人工坐席淹没在正常业务里
 *
 * injection_attempt 试图篡改系统指令 越权提权 或诱导绕过审批
 *                   处置 拒绝 且升级人工 且记审计
 *                   降级处理这类请求等于放弃纵深防御的第一道
 *
 * 判据必须可操作 识别信号清单写在 packages/agent/src/prompt.ts 的安全分流一节
 */
export const OVERREACH_KINDS = ['out_of_scope', 'injection_attempt'] as const
export const OverreachKind = z.enum(OVERREACH_KINDS)
export type OverreachKind = z.infer<typeof OverreachKind>

/**
 * 升级人工的原因分类 落审计供安全复盘与对抗沙箱统计
 *
 * injection_attempt 走独立审计动作 injection_attempt_blocked 其余走 escalated_to_human
 * 分开是为了让「被攻击且拦住了」可被单独计数 而不是淹没在正常升级里
 */
export const ESCALATION_KINDS = [
  'customer_request',
  'emotional',
  'service_failure',
  'injection_attempt',
] as const
export const EscalationKind = z.enum(ESCALATION_KINDS)
export type EscalationKind = z.infer<typeof EscalationKind>

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
  'run.handover',
  'operator.message',
  'run.resolved',
  // v4 深度可视化：门控与防线状态从 agent 内部计算提升为一等事件 供前端回放
  'tools.catalog_changed',
  'guard.blocked',
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
  // 升级人工不再是无出口的死终态 坐席接管后转人工处理
  escalated: ['handling_human'],
  // 人工处理中 坐席标记解决后回到 completed 终态
  handling_human: ['completed'],
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

export const COMPENSATION_TRANSITIONS: Readonly<
  Record<CompensationStatus, readonly CompensationStatus[]>
> = {
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

/**
 * 价保单状态 与补偿单同构的确定性状态机
 * 拒绝与过期不占位 降价状态变化后允许重新申请
 */
export const PRICE_PROTECTION_STATUSES = [
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
export const PriceProtectionStatus = z.enum(PRICE_PROTECTION_STATUSES)
export type PriceProtectionStatus = z.infer<typeof PriceProtectionStatus>

export const PRICE_PROTECTION_TRANSITIONS: Readonly<
  Record<PriceProtectionStatus, readonly PriceProtectionStatus[]>
> = {
  created: ['auto_approved', 'awaiting_approval', 'rejected', 'cancelled'],
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
