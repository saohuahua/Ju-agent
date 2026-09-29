/**
 * Agent 运行契约
 *
 * 模型只允许输出以下结构化形状 由 Zod 严格校验
 * 模型永远不能直接输出状态迁移命令 副作用只能通过 action 交给确定性工作流
 */

import { z } from 'zod'
import { EscalationKind, Intent, LogisticsEventStatus, RunStatus } from './enums.js'
import { CompensationReason } from './enums.js'
import { ToolIO, MoneyCents } from './tools.js'
import type { ToolName } from './tools.js'

/** 模型可调用的只读工具名 提示词目录与运行时白名单都来自这里 */
export const AGENT_TOOLS: ToolName[] = (Object.keys(ToolIO) as ToolName[]).filter(
  (name) =>
    name === 'lookup_customer' ||
    name === 'get_order' ||
    name === 'get_shipment' ||
    name === 'get_policy' ||
    name === 'search_policy',
)

/** 模型结构化输出判别联合 */
export const AgentOutput = z.discriminatedUnion('kind', [
  /** 调用只读工具收集信息 */
  z.object({
    kind: z.literal('tool_call'),
    tool: z.enum(AGENT_TOOLS as [ToolName, ...ToolName[]]),
    args: z.record(z.string(), z.unknown()),
    reason: z.string(),
  }),
  /** 向用户补问缺失信息 */
  z.object({
    kind: z.literal('clarify'),
    question: z.string().min(1),
    missingSlots: z.array(z.string()),
  }),
  /** 发起业务动作 交给确定性工作流执行 */
  z.object({
    kind: z.literal('action'),
    intent: Intent,
    slots: z.record(z.string(), z.unknown()),
    reason: z.string(),
  }),
  /** 给出最终答复 */
  z.object({
    kind: z.literal('final'),
    answer: z.string().min(1),
    escalated: z.boolean().default(false),
    summary: z.string().default(''),
  }),
  /** 升级人工 escalationKind 为升级原因分类 字段名避开判别键 kind */
  z.object({
    kind: z.literal('escalate'),
    reason: z.string().min(1),
    escalationKind: EscalationKind.default('customer_request'),
  }),
])
export type AgentOutput = z.infer<typeof AgentOutput>

/** 创建运行请求 customerId 由客户令牌推导 操作员创建时必须显式指定 */
export const CreateRunRequest = z.object({
  message: z.string().min(1),
  customerId: z.string().min(1).optional(),
  modelMode: z.enum(['simulation', 'live']).optional(),
})
export type CreateRunRequest = z.infer<typeof CreateRunRequest>

/** 补问答复请求 */
export const ContinueRunRequest = z.object({
  message: z.string().min(1),
  action: z.literal('end_consultation').optional(),
  returnShipment: z
    .object({ returnNo: z.string().min(1), trackingNo: z.string().trim().min(1).max(100) })
    .optional(),
})
export type ContinueRunRequest = z.infer<typeof ContinueRunRequest>

/** 人工受理不依赖模型 来源会话只用于归属校验和上下文关联 */
export const RequestHumanHelp = z.object({ sourceRunId: z.string().min(1).optional() }).strict()

/** 客户原售后只读进度 不公开内部授权与任务 */
export const CustomerRefundProgress = z.object({
  runId: z.string(),
  returnNo: z.string(),
  orderNo: z.string(),
  type: z.enum(['return', 'refund_only']),
  progress: z.enum([
    'awaiting_approval',
    'awaiting_shipment',
    'awaiting_receipt',
    'processing',
    'succeeded',
    'rejected',
    'expired',
    'cancelled',
    'failed',
    'unknown',
    'human',
  ]),
  canRegisterShipment: z.boolean(),
  shipmentRegistered: z.boolean(),
  trackingNo: z.string().nullable(),
})
export type CustomerRefundProgress = z.infer<typeof CustomerRefundProgress>

/** 审批决定请求 */
export const ApprovalDecisionRequest = z.object({
  decision: z.enum(['approved', 'rejected']),
  decidedBy: z.string().min(1),
})
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>

/** 物流事件注入请求 运营端点与评测剧本共用同一注入语义 */
export const LogisticsEventInjectRequest = z.object({
  orderNo: z.string().min(1),
  status: LogisticsEventStatus,
  description: z.string().min(1),
  /** 事件唯一标识 缺省由服务端生成 */
  eventId: z.string().min(1).optional(),
})
export type LogisticsEventInjectRequest = z.infer<typeof LogisticsEventInjectRequest>

/** 坐席人工消息请求 handling_human 会话内追加 客户端经 SSE 实时可见 */
export const OperatorMessageRequest = z.object({
  message: z.string().min(1),
})
export type OperatorMessageRequest = z.infer<typeof OperatorMessageRequest>

/** 坐席标记解决请求 附解决摘要 会话迁往 completed 终态 */
export const RunResolveRequest = z.object({
  summary: z.string().min(1),
})
export type RunResolveRequest = z.infer<typeof RunResolveRequest>

/** 运行对外摘要 */
export const RunSummary = z.object({
  runId: z.string(),
  customerId: z.string(),
  status: RunStatus,
  intent: z.string().nullable(),
  promptVersion: z.string(),
  model: z.string(),
  error: z.string().nullable(),
  /** 会话来源 customer 真实客户 sim 评测与模拟 运营指标只聚合前者 */
  source: z.enum(['customer', 'sim']).default('customer'),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type RunSummary = z.infer<typeof RunSummary>

/** 满意度评分请求 终态会话 客户身份 一 run 一评 */
export const RunRatingRequest = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().max(200).optional(),
})
export type RunRatingRequest = z.infer<typeof RunRatingRequest>

/** 满意度评分落库形态 */
export const RunRatingView = z.object({
  runId: z.string(),
  score: z.number().int().min(1).max(5),
  comment: z.string().nullable(),
  submittedAt: z.string(),
})
export type RunRatingView = z.infer<typeof RunRatingView>

/** 各意图的槽位契约 用于校验模型给出的 action 参数 */
export const INTENT_SLOT_SCHEMAS = {
  query_order: z.object({ orderNo: z.string().min(1) }),
  submit_return: z.object({
    orderNo: z.string().min(1),
    reason: z.enum(['no_reason', 'quality', 'damaged', 'wrong_item']),
    itemIds: z.array(z.string()).optional(),
  }),
  submit_refund_only: z.object({
    orderNo: z.string().min(1),
    reason: z.enum(['unshipped_cancel', 'lost_package', 'quality', 'damaged', 'wrong_item']),
  }),
  submit_exchange: z.object({
    orderNo: z.string().min(1),
    reason: z.enum(['quality', 'damaged', 'wrong_item']),
    itemIds: z.array(z.string()).optional(),
  }),
  cancel_return: z.object({ returnNo: z.string().min(1) }),
  compensation: z.object({
    orderNo: z.string().min(1),
    reason: CompensationReason,
    amountCents: MoneyCents,
  }),
  price_protection: z.object({
    orderNo: z.string().min(1),
    /** 部分价保时指定的商品 为空表示整单 差价由系统按当前售价计算 */
    itemIds: z.array(z.string()).optional(),
  }),
  escalate: z.object({
    reason: z.string().min(1),
    /**
     * 升级原因分类 模型自评 缺省按客户主动要求
     *
     * 分类只影响审计口径 不影响是否真的升级——是否升级由模型调用本工具这件事本身决定
     * 模型误分类不会放过攻击 只会让安全统计偏低 这是保守的失败方向
     */
    kind: EscalationKind.default('customer_request'),
  }),
} as const

export type IntentSlotValidation =
  { ok: true; slots: Record<string, unknown> } | { ok: false; message: string }
