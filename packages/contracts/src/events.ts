/**
 * SSE 事件协议
 *
 * 每个事件携带 runId 单调整数 sequence 与类型化 payload
 * 事件是唯一的事实来源 UI 与模型上下文都从事件流归约 不依赖内存临时对象
 * 客户端断线后通过 Last-Event-ID 携带最后收到的 sequence 服务端从该序号之后补发
 */

import { z } from 'zod'
import { OrderCandidates } from './order-selection.js'
import {
  ErrorCode,
  EventType,
  GuardLayer,
  LogisticsEventStatus,
  RiskLevel,
  ToolGateReason,
} from './enums.js'

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
  'order.candidates': OrderCandidates,
  'run.started': z.object({
    customerId: z.string(),
    promptVersion: z.string(),
    model: z.string(),
  }),
  'message.user': z.object({
    text: z.string(),
    /** 请求键用于确认本地消息 旧事件缺省时不按文本猜测关联 */
    requestKey: z.string().max(200).optional(),
    /** 用户回复针对的提问工具调用 缺省为普通消息 */
    replyToToolCallId: z.string().optional(),
  }),
  'message.delta': z.object({ textDelta: z.string() }),
  'message.completed': z.object({
    role: z.enum(['assistant']),
    text: z.string(),
  }),
  /** 模型结构化输出 持久化用于上下文重建与轨迹审计 */
  'agent.output': z.object({
    output: z.record(z.string(), z.unknown()),
  }),
  /** 模型轮次记录 原生内容块 持久化用于上下文重建与审计 */
  'agent.turn': z.object({
    blocks: z.array(
      z.union([
        z.object({ type: z.literal('text'), text: z.string() }),
        z.object({
          type: z.literal('tool_use'),
          toolCallId: z.string(),
          toolName: z.string(),
          input: z.record(z.string(), z.unknown()),
        }),
      ]),
    ),
    stopReason: z.enum(['end_turn', 'tool_use', 'max_tokens']),
  }),
  /** 工具结果回灌 转为 user 轮的 tool_result 块喂回模型 */
  'agent.tool_results': z.object({
    results: z.array(
      z.object({
        toolCallId: z.string(),
        toolName: z.string(),
        content: z.string(),
        isError: z.boolean(),
      }),
    ),
  }),
  /** 工具参数流式增量 前端渐进渲染工具调用 */
  'tool.input.delta': z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    partialJson: z.string(),
  }),
  /** 上下文压缩记录 量化上下文工程效果 */
  'context.compacted': z.object({
    strategy: z.enum(['tool_result_clearing', 'summarization']),
    beforeTokens: z.number().int().nonnegative(),
    afterTokens: z.number().int().nonnegative(),
    /**
     * 压缩后三段各自的 token 占比 由 agent 实测而非前端估算
     *
     * 可选字段 历史事件没有这一段 前端需按缺省降级为只展示总量
     * 加这个字段是为了让「上下文工程可量化」有后端实测撑腰 估算值撑不住该说法
     */
    segments: z
      .object({
        /** 状态便签 从事件流派生的结构化摘要 */
        workingMemory: z.number().int().nonnegative(),
        /** 保留的最近消息 */
        recent: z.number().int().nonnegative(),
        /** 被清理的历史工具结果 压缩腾出的空间 */
        compacted: z.number().int().nonnegative(),
      })
      .optional(),
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
    consultation: z.enum(['ready', 'clarify']).optional(),
    showChoices: z.boolean().optional(),
    missingSlot: z.string().optional(),
    reason: z.enum(['awaiting_input', 'awaiting_approval']),
    /** 补问文本或审批提示 */
    hint: z.string().optional(),
  }),
  'run.resumed': z.object({
    /** 恢复来源 用户补答 审批决定 断点恢复 或物流事件触达 */
    resumePoint: z.enum(['user_message', 'approval', 'checkpoint', 'logistics_event']),
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
  /**
   * 物流推送事件 会话中途注入的物流状态变化
   * 领域服务校验通过后落表 上下文重建时合成为 user 消息
   * 会话空闲时触发主动触达回合 其余状态挂起至下一轮
   */
  'logistics.event': z.object({
    orderNo: z.string(),
    carrier: z.string(),
    trackingNo: z.string(),
    status: LogisticsEventStatus,
    description: z.string(),
    /** 事件唯一标识 重复注入按此幂等拒绝 */
    eventId: z.string(),
    /** 注入来源 运营端点手动注入或评测剧本触发 */
    source: z.enum(['operator', 'simulator']),
    injectedAt: z.string(),
  }),
  /** 坐席接管 escalated 会话转人工处理 状态迁往 handling_human */
  'run.handover': z.object({
    /** 接管者标识 操作员或主管 */
    takenBy: z.string(),
  }),
  /** 坐席消息 人工处理中直接落事件流 不经模型 客户端经 SSE 实时可见 */
  'operator.message': z.object({
    text: z.string().min(1),
    sentBy: z.string(),
  }),
  /** 坐席标记解决 附解决摘要 会话迁往 completed 终态 */
  'run.resolved': z.object({
    summary: z.string(),
    resolvedBy: z.string(),
  }),
  'human.requested': z.object({ sourceRunId: z.string().nullable() }),
  /**
   * 工具目录变更 能力门控的可观测化
   *
   * agent 每轮构建工具目录时发出 目录内容不变则不重复发
   * visible 是本轮真正喂给模型的工具 gated 是存在但被门控挡住的
   * 「未查过订单前动作工具不进目录」这条结构性防盲提交由此从代码行为变成可回放事实
   */
  'tools.catalog_changed': z.object({
    visible: z.array(z.string()),
    gated: z.array(z.string()),
    reason: ToolGateReason,
  }),
  /**
   * 防线拦截 三道闸任一挡下重复副作用时落事件
   *
   * 拦截即代表未产生资金动作 这是幂等三道防线的直接证据
   * key 为拦截所依据的键（幂等键 审批令牌 或网关请求指纹）已脱敏
   */
  'guard.blocked': z.object({
    layer: GuardLayer,
    key: z.string(),
    /** 被拦下的动作 如 execute_refund */
    action: z.string(),
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
