/**
 * Agent 运行契约
 *
 * 模型只允许输出以下结构化形状 由 Zod 严格校验
 * 模型永远不能直接输出状态迁移命令 副作用只能通过 action 交给确定性工作流
 */

import { z } from 'zod'
import { Intent, RunStatus } from './enums.js'
import { CompensationReason } from './enums.js'
import { ToolIO, MoneyCents } from './tools.js'
import type { ToolName } from './tools.js'

/** 模型可调用的只读工具名 提示词目录与运行时白名单都来自这里 */
export const AGENT_TOOLS: ToolName[] = (Object.keys(ToolIO) as ToolName[]).filter(
  (name) =>
    name === 'lookup_customer' ||
    name === 'get_order' ||
    name === 'get_shipment' ||
    name === 'get_policy',
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
  /** 升级人工 */
  z.object({
    kind: z.literal('escalate'),
    reason: z.string().min(1),
  }),
])
export type AgentOutput = z.infer<typeof AgentOutput>

/** 创建运行请求 customerId 由客户令牌推导 操作员创建时必须显式指定 */
export const CreateRunRequest = z.object({
  message: z.string().min(1),
  customerId: z.string().min(1).optional(),
})
export type CreateRunRequest = z.infer<typeof CreateRunRequest>

/** 补问答复请求 */
export const ContinueRunRequest = z.object({
  message: z.string().min(1),
})
export type ContinueRunRequest = z.infer<typeof ContinueRunRequest>

/** 审批决定请求 */
export const ApprovalDecisionRequest = z.object({
  decision: z.enum(['approved', 'rejected']),
  decidedBy: z.string().min(1),
})
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>

/** 运行对外摘要 */
export const RunSummary = z.object({
  runId: z.string(),
  customerId: z.string(),
  status: RunStatus,
  intent: z.string().nullable(),
  promptVersion: z.string(),
  model: z.string(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type RunSummary = z.infer<typeof RunSummary>

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
  escalate: z.object({ reason: z.string().min(1) }),
} as const

export type IntentSlotValidation =
  { ok: true; slots: Record<string, unknown> } | { ok: false; message: string }
