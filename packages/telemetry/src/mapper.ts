/**
 * 会话事实到 OTLP JSON 的映射
 *
 * 输入已是读出的行 本模块不访问数据库
 * 时长优先使用 latencyMs 与账本时间戳 事件 created_at 只做排序与下界
 * GenAI 属性按 2026-09-29 语义约定 Development 快照填写
 */

import {
  SPAN_KIND_CLIENT,
  SPAN_KIND_INTERNAL,
  STATUS_ERROR,
  STATUS_OK,
  type OtlpEvent,
  type OtlpKeyValue,
  type OtlpSpan,
  type OtlpTrace,
} from './otlp.js'
import { otelSpanId, otelTraceId } from './trace-id.js'

export interface TraceRunRecord {
  runId: string
  customerId: string
  status: string
  promptVersion: string
  model: string
  source: string
  createdAt: string
  updatedAt: string
}

export interface TraceEvent {
  sequence: number
  type: string
  payload: unknown
  createdAt: string
}

export interface TraceToolExecution {
  id: number
  toolName: string
  status: 'succeeded' | 'failed'
  errorCode: string | null
  attempt: number
  latencyMs: number
  createdAt: string
}

export interface TraceModelCall {
  callId: string
  purpose: string
  attempt: number
  status: 'held' | 'unknown' | 'settled'
  outcome: string | null
  usage: { inputTokens: number; outputTokens: number } | null
  createdAt: string
  settledAt: string | null
}

export interface TraceSource {
  run: TraceRunRecord
  events: TraceEvent[]
  tools: TraceToolExecution[]
  calls: TraceModelCall[]
}

function toUnixNano(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '0'
  return `${ms}000000`
}

function addMs(iso: string, ms: number): string {
  const start = Date.parse(iso)
  if (!Number.isFinite(start)) return iso
  return new Date(start + Math.max(0, ms)).toISOString()
}

function laterNano(startNano: string, endNano: string): string {
  return BigInt(endNano) >= BigInt(startNano) ? endNano : `${BigInt(startNano) + 1n}`
}

function str(key: string, value: string): OtlpKeyValue {
  return { key, value: { stringValue: value } }
}

function intAttr(key: string, value: number): OtlpKeyValue {
  return { key, value: { intValue: String(Math.trunc(value)) } }
}

function boolAttr(key: string, value: boolean): OtlpKeyValue {
  return { key, value: { boolValue: value } }
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

function providerName(model: string): string {
  return model.includes('scripted') ? 'scripted' : 'aftersales.gateway'
}

function turnStopReason(payload: unknown): string | undefined {
  const reason = payloadRecord(payload).stopReason
  return typeof reason === 'string' ? reason : undefined
}

/**
 * 把一次运行映射为单 trace
 *
 * 前置 调用方已按 sequence 与 created_at 排好序亦可 本函数会再排一次
 * 结果 root span 覆盖会话寿命 chat span 对应模型调用 execute_tool 对应工具执行行
 */
export function mapRunToOtlp(source: TraceSource): OtlpTrace {
  const { run } = source
  const events = [...source.events].sort((a, b) => a.sequence - b.sequence)
  const traceId = otelTraceId(run.runId)
  const rootId = otelSpanId(`run:${run.runId}`)
  const startNano = toUnixNano(run.createdAt)
  const latestIso = [
    run.updatedAt,
    ...events.map((event) => event.createdAt),
    ...source.tools.map((tool) => addMs(tool.createdAt, tool.latencyMs)),
    ...source.calls.map((call) => call.settledAt ?? call.createdAt),
  ].reduce((latest, iso) => (Date.parse(iso) > Date.parse(latest) ? iso : latest), run.createdAt)
  const endNano = laterNano(startNano, toUnixNano(latestIso))
  const compactedAt = events
    .filter((event) => event.type === 'context.compacted')
    .map((event) => event.createdAt)

  const rootEvents: OtlpEvent[] = []
  for (const event of events) {
    if (
      event.type !== 'context.compacted' &&
      event.type !== 'guard.blocked' &&
      event.type !== 'tools.catalog_changed'
    ) {
      continue
    }
    const payload = payloadRecord(event.payload)
    const attributes: OtlpKeyValue[] = []
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        attributes.push(
          typeof value === 'string'
            ? str(key, value)
            : typeof value === 'number'
              ? intAttr(key, value)
              : boolAttr(key, value),
        )
      }
    }
    rootEvents.push({
      timeUnixNano: toUnixNano(event.createdAt),
      name: event.type,
      attributes,
    })
  }

  const root: OtlpSpan = {
    traceId,
    spanId: rootId,
    name: `run ${run.runId}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    attributes: [
      str('gen_ai.conversation.id', run.runId),
      str('gen_ai.prompt.name', 'aftersales-copilot'),
      str('gen_ai.prompt.version', run.promptVersion),
      str('gen_ai.request.model', run.model),
      str('gen_ai.provider.name', providerName(run.model)),
      str('aftersales.run.source', run.source),
      str('aftersales.run.status', run.status),
      str('aftersales.run.customer_id', run.customerId),
    ],
    events: rootEvents,
    status: { code: run.status === 'failed' ? STATUS_ERROR : STATUS_OK },
  }

  const spans: OtlpSpan[] = [root]
  const turns = events.filter((event) => event.type === 'agent.turn')

  if (source.calls.length > 0) {
    for (const call of source.calls) {
      const spanStart = toUnixNano(call.createdAt)
      const spanEnd = laterNano(spanStart, toUnixNano(call.settledAt ?? addMs(call.createdAt, 1)))
      const compacted = compactedAt.some((at) => Date.parse(at) <= Date.parse(call.createdAt))
      const turn = turns.find((item) => Date.parse(item.createdAt) >= Date.parse(call.createdAt))
      const attributes: OtlpKeyValue[] = [
        str('gen_ai.operation.name', 'chat'),
        str('gen_ai.provider.name', providerName(run.model)),
        str('gen_ai.request.model', run.model),
        str('gen_ai.conversation.id', run.runId),
        str('gen_ai.prompt.version', run.promptVersion),
        boolAttr('gen_ai.conversation.compacted', compacted),
        intAttr('aftersales.model.attempt', call.attempt),
        str('aftersales.model.purpose', call.purpose),
        str('aftersales.model.call_id', call.callId),
      ]
      if (call.usage) {
        attributes.push(intAttr('gen_ai.usage.input_tokens', call.usage.inputTokens))
        attributes.push(intAttr('gen_ai.usage.output_tokens', call.usage.outputTokens))
      }
      const finish = turn ? turnStopReason(turn.payload) : undefined
      if (finish) attributes.push(str('gen_ai.response.finish_reasons', finish))
      spans.push({
        traceId,
        spanId: otelSpanId(`chat:${call.callId}`),
        parentSpanId: rootId,
        name: `chat ${run.model}`,
        kind: SPAN_KIND_CLIENT,
        startTimeUnixNano: spanStart,
        endTimeUnixNano: spanEnd,
        attributes,
        events: [],
        status: {
          code: call.status === 'settled' ? STATUS_OK : STATUS_ERROR,
          message: call.outcome ?? undefined,
        },
      })
    }
  } else {
    for (const [index, turn] of turns.entries()) {
      const spanStart = toUnixNano(turn.createdAt)
      const spanEnd = laterNano(spanStart, toUnixNano(addMs(turn.createdAt, 1)))
      const compacted = compactedAt.some((at) => Date.parse(at) <= Date.parse(turn.createdAt))
      const finish = turnStopReason(turn.payload)
      const attributes: OtlpKeyValue[] = [
        str('gen_ai.operation.name', 'chat'),
        str('gen_ai.provider.name', providerName(run.model)),
        str('gen_ai.request.model', run.model),
        str('gen_ai.conversation.id', run.runId),
        boolAttr('gen_ai.conversation.compacted', compacted),
      ]
      if (finish) attributes.push(str('gen_ai.response.finish_reasons', finish))
      spans.push({
        traceId,
        spanId: otelSpanId(`chat-turn:${run.runId}:${index}`),
        parentSpanId: rootId,
        name: `chat ${run.model}`,
        kind: SPAN_KIND_CLIENT,
        startTimeUnixNano: spanStart,
        endTimeUnixNano: spanEnd,
        attributes,
        events: [],
        status: { code: STATUS_OK },
      })
    }
  }

  for (const tool of source.tools) {
    const spanStart = toUnixNano(tool.createdAt)
    const spanEnd = laterNano(spanStart, toUnixNano(addMs(tool.createdAt, tool.latencyMs)))
    const attributes: OtlpKeyValue[] = [
      str('gen_ai.tool.name', tool.toolName),
      intAttr('aftersales.tool.attempt', tool.attempt),
      intAttr('aftersales.tool.latency_ms', tool.latencyMs),
    ]
    if (tool.errorCode) attributes.push(str('error.type', tool.errorCode))
    spans.push({
      traceId,
      spanId: otelSpanId(`tool:${run.runId}:${tool.id}`),
      parentSpanId: rootId,
      name: `execute_tool ${tool.toolName}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: spanStart,
      endTimeUnixNano: spanEnd,
      attributes,
      events: [],
      status: {
        code: tool.status === 'succeeded' ? STATUS_OK : STATUS_ERROR,
        message: tool.errorCode ?? undefined,
      },
    })
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            str('service.name', 'aftersales-copilot'),
            str('telemetry.sdk.language', 'typescript'),
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'aftersales.telemetry', version: '0.1.0' },
            spans,
          },
        ],
      },
    ],
  }
}

export function attrValue(
  attributes: OtlpKeyValue[],
  key: string,
): string | number | boolean | undefined {
  const hit = attributes.find((item) => item.key === key)
  if (!hit) return undefined
  if ('stringValue' in hit.value) return hit.value.stringValue
  if ('intValue' in hit.value) return Number(hit.value.intValue)
  if ('boolValue' in hit.value) return hit.value.boolValue
  if ('doubleValue' in hit.value) return hit.value.doubleValue
  return undefined
}
