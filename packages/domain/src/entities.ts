/**
 * 领域实体类型
 *
 * 实体是纯数据 不含行为 行为在服务中
 * 金额一律使用整数分 时间一律使用 UTC ISO 字符串
 */

import type {
  CompensationReason,
  CompensationStatus,
  PriceProtectionStatus,
  ReturnType,
  ReturnReason,
  ReturnStatus,
  RefundStatus,
  ApprovalStatus,
  RunStatus,
} from '@aftersales/contracts'
import type { OrderItem } from '@aftersales/contracts'

export interface Customer {
  customerId: string
  name: string
  /** 数据库仅保存脱敏手机号 源头不落明文 */
  phoneMasked: string
  createdAt: string
}

export interface Order {
  orderNo: string
  customerId: string
  status: 'paid' | 'shipped' | 'delivered' | 'completed' | 'cancelled'
  totalAmountCents: number
  currency: string
  paymentChannel: string
  items: OrderItem[]
  paidAt: string | null
  shippedAt: string | null
  deliveredAt: string | null
  createdAt: string
  updatedAt: string
  /** 乐观锁版本号 */
  version: number
}

export interface ShipmentEventEntry {
  time: string
  description: string
  /** 注入事件的唯一标识 同 id 重复注入按此幂等拒绝 */
  eventId?: string
}

export interface Shipment {
  shipmentId: string
  orderNo: string
  carrier: string
  trackingNo: string
  status: 'in_transit' | 'delayed' | 'delivered' | 'lost' | 'exception'
  events: ShipmentEventEntry[]
  deliveredAt: string | null
  updatedAt: string
  /** 乐观锁版本号 */
  version: number
}

export interface PolicyDecisionRecord {
  outcome: 'allow' | 'deny' | 'needs_approval'
  ruleId: string
  explanation: string
  feeBearer: 'seller' | 'buyer' | null
}

export interface ReturnRequest {
  returnNo: string
  orderNo: string
  customerId: string
  type: ReturnType
  reason: ReturnReason
  status: ReturnStatus
  itemIds: string[]
  refundAmountCents: number
  currency: string
  policyDecision: PolicyDecisionRecord
  policyVersion: string
  createdAt: string
  updatedAt: string
  version: number
}

export interface Refund {
  refundNo: string
  returnNo: string
  orderNo: string
  amountCents: number
  currency: string
  channel: string
  status: RefundStatus
  idempotencyKey: string
  attempts: number
  lastError: string | null
  createdAt: string
  updatedAt: string
  version: number
}

export interface ApprovalRequest {
  approvalId: string
  runId: string | null
  resourceType: string
  resourceId: string
  reason: string
  amountCents: number
  status: ApprovalStatus
  /** 一次性令牌 高风险工具执行时必须匹配且立即消费 */
  oneTimeToken: string
  requestedBy: string
  decidedBy: string | null
  decidedAt: string | null
  expiresAt: string
  createdAt: string
}

/** 补偿单 现金红包安抚 分级审批 与售后单相互独立 */
export interface Compensation {
  compensationNo: string
  orderNo: string
  customerId: string
  reason: CompensationReason
  status: CompensationStatus
  amountCents: number
  currency: string
  /** 发放渠道 创建时从订单快照 与退款单同构 执行时不回查订单 */
  channel: string
  requiresApproval: boolean
  policyVersion: string
  createdAt: string
  updatedAt: string
  version: number
}

/** 价保明细行 成交价与当前售价的差额按数量计算 */
export interface PriceProtectionItem {
  itemId: string
  sku: string
  purchasePriceCents: number
  currentPriceCents: number
  quantity: number
  refundCents: number
}

/** 价保单 自签收起 7 天窗口内 降价商品按差价退还 同一订单仅一次 */
export interface PriceProtection {
  protectionNo: string
  orderNo: string
  customerId: string
  status: PriceProtectionStatus
  amountCents: number
  currency: string
  /** 发放渠道 创建时从订单快照 执行时不回查订单 */
  channel: string
  /** 命中降价的商品明细 政策拒绝时为空 */
  items: PriceProtectionItem[]
  requiresApproval: boolean
  /** 命中政策规则 拒绝时记录拒赔依据 */
  policyRuleId: string
  policyVersion: string
  createdAt: string
  updatedAt: string
  version: number
}

/** 商品当前售价 价保差额计算的参照价 */
export interface SkuPrice {
  sku: string
  currentUnitPriceCents: number
  updatedAt: string
}

export interface PolicyRule {
  ruleId: string
  policyVersion: string
  description: string
  timeWindowDays: number | null
  excludedCategories: string[] | null
}

export interface AuditLog {
  id: number
  occurredAt: string
  actorRole: string
  actorId: string
  action: string
  resourceType: string
  resourceId: string
  detail: Record<string, unknown>
  runId: string | null
}

export interface ToolExecutionRecord {
  id: number
  runId: string | null
  toolName: string
  args: Record<string, unknown>
  status: 'succeeded' | 'failed'
  errorCode: string | null
  attempt: number
  latencyMs: number
  resultSummary: Record<string, unknown> | null
  createdAt: string
}

export interface Checkpoint {
  id: number
  runId: string
  stepId: string
  state: Record<string, unknown>
  createdAt: string
}

export interface AgentRunRecord {
  runId: string
  customerId: string
  status: RunStatus
  intent: string | null
  promptVersion: string
  model: string
  error: string | null
  /** 评测注入的故障计划 生产路径恒为空 */
  faultPlan: unknown[]
  createdAt: string
  updatedAt: string
}

/** 操作身份 客户只能触达自己的资源 操作员与主管按角色放行 */
export interface Actor {
  role: 'customer' | 'operator' | 'supervisor'
  customerId?: string
}
