/**
 * SSE 事件协议
 *
 * 每个事件携带 runId 单调整数 sequence 与类型化 payload
 * 事件是唯一的事实来源 UI 与模型上下文都从事件流归约 不依赖内存临时对象
 * 客户端断线后通过 Last-Event-ID 携带最后收到的 sequence 服务端从该序号之后补发
 */

import { z } from 'zod'
import { ErrorCode, EventType, RiskLevel } from './enums.js'

/** 持久化事件行 内含自增全局 id 与 run 内单调 sequence */
export const AgentEventRow = z.object({
  runId: z.string(),
  sequence: z.number().int().positive(),
  type: EventType,
  payload: z.unknown(),
  createdAt: z.string(),
})
export type AgentEventRow = z.infer<typeof AgentEventRow>

/** 各事件类型的 payload 契约 与 EventType 一一对应 */
export const EVENT_PAYLOAD_SCHEMAS = {
  'run.started': z.object({
    customerId: z.string(),
    promptVersion: z.string(),
    model: z.string(),
  }),
  'message.user': z.object({ text: z.string() }),
  'message.delta': z.object({ textDelta: z.string() }),
  'message.completed': z.object({
    role: z.enum(['assistant']),
    text: z.string(),
  }),
  /** 模型结构化输出 持久化用于上下文重建与轨迹审计 */
  'agent.output': z.object({
    output: z.record(z.string(), z.unknown()),
  }),
  'step.started': z.object({
    stepId: z.string(),
    stepName: z.string(),
  }),
  'step.completed': z.object({
    stepId: z.string(),
    outcome: z.enum(['ok', 'skipped', 'failed']),
  }),
  'tool.requested': z.object({
    executionId: z.string(),
    toolName: z.string(),
    attempt: z.number().int().positive(),
    /** 已脱敏的参数摘要 */
    args: z.record(z.string(), z.unknown()),
  }),
  'tool.completed': z.object({
    executionId: z.string(),
    toolName: z.string(),
    status: z.enum(['succeeded', 'failed']),
    /** 结果摘要 严禁包含未脱敏 PII */
    resultSummary: z.record(z.string(), z.unknown()).optional(),
    errorCode: ErrorCode.optional(),
    latencyMs: z.number().int().nonnegative(),
  }),
  'approval.required': z.object({
    approvalId: z.string(),
    riskLevel: RiskLevel,
    /** 审批针对的业务资源 */
    resourceType: z.string(),
    resourceId: z.string(),
    amountCents: z.number().int().nonnegative(),
    reason: z.string(),
    /** 审批有效期限 ISO 时间 */
    expiresAt: z.string(),
  }),
  'approval.decided': z.object({
    approvalId: z.string(),
    decision: z.enum(['approved', 'rejected', 'expired']),
    decidedBy: z.string(),
  }),
  'run.paused': z.object({
    reason: z.enum(['awaiting_input', 'awaiting_approval']),
    /** 补问文本或审批提示 */
    hint: z.string().optional(),
  }),
  'run.resumed': z.object({
    /** 恢复来源 用户补答 审批决定 或断点恢复 */
    resumePoint: z.enum(['user_message', 'approval', 'checkpoint']),
  }),
  'run.failed': z.object({
    errorCode: ErrorCode,
    message: z.string(),
  }),
  'run.completed': z.object({
    summary: z.string(),
    escalated: z.boolean(),
  }),
  'run.escalated': z.object({
    reason: z.string(),
  }),
} as const

/** 事件类型到 payload 的类型映射 供运行时与前端共享 */
export type EventPayloadMap = {
  [K in keyof typeof EVENT_PAYLOAD_SCHEMAS]: z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[K]>
}

/** 构造带类型的领域事件 工作流与 Agent 统一经由事件仓储追加 */
export type TypedEvent<K extends keyof EventPayloadMap> = {
  runId: string
  type: K
  payload: EventPayloadMap[K]
}

/** SSE 线格式编码 id 对应 sequence 断线重连时浏览器自动回传 Last-Event-ID */
export function encodeSseChunk(event: AgentEventRow): string {
  const lines = [
    `id: ${event.sequence}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify({ runId: event.runId, sequence: event.sequence, type: event.type, payload: event.payload, createdAt: event.createdAt })}`,
  ]
  return lines.join('\n') + '\n\n'
}
