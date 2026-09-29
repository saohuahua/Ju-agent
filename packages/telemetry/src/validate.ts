/**
 * 导出结果与源事实交叉核对
 *
 * 全部为确定性断言 失败返回人类可读条目 空数组表示通过
 * 不调用外部 collector
 */

import { OtlpTrace, type OtlpSpan } from './otlp.js'
import { attrValue, type TraceSource } from './mapper.js'
import { otelTraceId } from './trace-id.js'

function spansOf(trace: ReturnType<typeof OtlpTrace.parse>): OtlpSpan[] {
  return trace.resourceSpans[0]?.scopeSpans[0]?.spans ?? []
}

/**
 * 校验导出
 *
 * 前置 trace 为 mapRunToOtlp 或其等价结构
 * 异常路径 结构不合法时只返回 schema 错误 不再做数值对照
 */
export function validateTrace(source: TraceSource, trace: unknown): string[] {
  const parsed = OtlpTrace.safeParse(trace)
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => `${issue.path.join('.')}:${issue.message}`)
  }
  const errors: string[] = []
  const spans = spansOf(parsed.data)
  const expectedTraceId = otelTraceId(source.run.runId)
  for (const span of spans) {
    if (span.traceId !== expectedTraceId) errors.push(`span ${span.name} traceId 与 runId 不一致`)
    if (BigInt(span.endTimeUnixNano) < BigInt(span.startTimeUnixNano)) {
      errors.push(`span ${span.name} 结束早于开始`)
    }
  }

  const root = spans.find((span) => span.name === `run ${source.run.runId}`)
  if (!root) errors.push('缺少 root span')
  const children = spans.filter((span) => span.parentSpanId)
  if (root) {
    for (const child of children) {
      if (BigInt(child.startTimeUnixNano) < BigInt(root.startTimeUnixNano)) {
        errors.push(`span ${child.name} 超出 root 起始`)
      }
      if (BigInt(child.endTimeUnixNano) > BigInt(root.endTimeUnixNano) + 1_000_000n) {
        errors.push(`span ${child.name} 超出 root 结束`)
      }
    }
  }

  const chatSpans = spans.filter((span) => span.name.startsWith('chat '))
  if (source.calls.length > 0 && chatSpans.length !== source.calls.length) {
    errors.push(`chat span 数量 ${chatSpans.length} 与模型调用 ${source.calls.length} 不一致`)
  }
  for (const call of source.calls) {
    if (!call.usage) continue
    const span = chatSpans.find(
      (item) => attrValue(item.attributes, 'aftersales.model.call_id') === call.callId,
    )
    if (!span) {
      errors.push(`缺少 call ${call.callId} 的 chat span`)
      continue
    }
    if (attrValue(span.attributes, 'gen_ai.usage.input_tokens') !== call.usage.inputTokens) {
      errors.push(`call ${call.callId} 输入 token 与账本不一致`)
    }
    if (attrValue(span.attributes, 'gen_ai.usage.output_tokens') !== call.usage.outputTokens) {
      errors.push(`call ${call.callId} 输出 token 与账本不一致`)
    }
  }

  const toolSpans = spans.filter((span) => span.name.startsWith('execute_tool '))
  if (toolSpans.length !== source.tools.length) {
    errors.push(
      `execute_tool span 数量 ${toolSpans.length} 与工具执行 ${source.tools.length} 不一致`,
    )
  }
  for (const tool of source.tools) {
    const span = toolSpans.find(
      (item) =>
        attrValue(item.attributes, 'gen_ai.tool.name') === tool.toolName &&
        attrValue(item.attributes, 'aftersales.tool.attempt') === tool.attempt &&
        attrValue(item.attributes, 'aftersales.tool.latency_ms') === tool.latencyMs,
    )
    if (!span) errors.push(`缺少工具 ${tool.toolName} attempt ${tool.attempt} 的 span`)
    else if (tool.status === 'failed' && span.status.code !== 2) {
      errors.push(`工具 ${tool.toolName} 失败未反映到 span status`)
    }
  }

  const compactedEvents = source.events.filter((event) => event.type === 'context.compacted')
  const compactedSpanEvents = (root?.events ?? []).filter(
    (event) => event.name === 'context.compacted',
  )
  if (compactedEvents.length !== compactedSpanEvents.length) {
    errors.push('context.compacted 事件与 span event 数量不一致')
  }
  const blocked = source.events.filter((event) => event.type === 'guard.blocked')
  const blockedEvents = (root?.events ?? []).filter((event) => event.name === 'guard.blocked')
  if (blocked.length !== blockedEvents.length) {
    errors.push('guard.blocked 事件与 span event 数量不一致')
  }

  return errors
}
