/**
 * 映射与校验
 *
 * 用固定会话事实覆盖压缩 工具失败 防线拦截与用量对照
 */

import { describe, expect, it } from 'vitest'
import { attrValue, mapRunToOtlp, type TraceSource } from '../src/mapper.js'
import { validateTrace } from '../src/validate.js'
import { otelTraceId } from '../src/trace-id.js'

function source(overrides: Partial<TraceSource> = {}): TraceSource {
  return {
    run: {
      runId: 'run_abc12',
      customerId: 'C1001',
      status: 'completed',
      promptVersion: 'v2.5',
      model: 'scripted-v1',
      source: 'customer',
      createdAt: '2026-09-20T12:00:00.000Z',
      updatedAt: '2026-09-20T12:00:05.000Z',
    },
    events: [
      {
        sequence: 1,
        type: 'run.started',
        payload: { customerId: 'C1001', promptVersion: 'v2.5', model: 'scripted-v1' },
        createdAt: '2026-09-20T12:00:00.000Z',
      },
      {
        sequence: 2,
        type: 'context.compacted',
        payload: { strategy: 'tool_result_clearing', beforeTokens: 900, afterTokens: 400 },
        createdAt: '2026-09-20T12:00:01.000Z',
      },
      {
        sequence: 3,
        type: 'agent.turn',
        payload: { stopReason: 'tool_use', blocks: [] },
        createdAt: '2026-09-20T12:00:02.000Z',
      },
      {
        sequence: 4,
        type: 'tool.requested',
        payload: { executionId: 'ex1', toolName: 'get_order', attempt: 1 },
        createdAt: '2026-09-20T12:00:02.100Z',
      },
      {
        sequence: 5,
        type: 'guard.blocked',
        payload: { layer: 'idempotency', key: 'refund:1', action: 'execute_refund' },
        createdAt: '2026-09-20T12:00:03.000Z',
      },
      {
        sequence: 6,
        type: 'run.completed',
        payload: { summary: '完成', escalated: false },
        createdAt: '2026-09-20T12:00:05.000Z',
      },
    ],
    tools: [
      {
        id: 1,
        toolName: 'get_order',
        status: 'failed',
        errorCode: 'TIMEOUT',
        attempt: 1,
        latencyMs: 40,
        createdAt: '2026-09-20T12:00:02.100Z',
      },
    ],
    calls: [
      {
        callId: 'call_1',
        purpose: 'main_agent',
        attempt: 1,
        status: 'settled',
        outcome: 'ok',
        usage: { inputTokens: 120, outputTokens: 30 },
        createdAt: '2026-09-20T12:00:01.500Z',
        settledAt: '2026-09-20T12:00:02.000Z',
      },
    ],
    ...overrides,
  }
}

describe('OTLP 映射', () => {
  it('导出合法 trace 并通过交叉校验', () => {
    const input = source()
    const trace = mapRunToOtlp(input)
    expect(validateTrace(input, trace)).toEqual([])
    const spans = trace.resourceSpans[0]!.scopeSpans[0]!.spans
    expect(spans[0]!.traceId).toBe(otelTraceId('run_abc12'))
    const chat = spans.find((span) => span.name === 'chat scripted-v1')
    expect(attrValue(chat!.attributes, 'gen_ai.usage.input_tokens')).toBe(120)
    expect(attrValue(chat!.attributes, 'gen_ai.conversation.compacted')).toBe(true)
    const tool = spans.find((span) => span.name === 'execute_tool get_order')
    expect(tool?.status.code).toBe(2)
    expect(attrValue(tool!.attributes, 'error.type')).toBe('TIMEOUT')
    expect(spans[0]!.events.map((event) => event.name)).toEqual([
      'context.compacted',
      'guard.blocked',
    ])
  })

  it('无账本时用 agent.turn 生成 chat span', () => {
    const input = source({ calls: [] })
    const trace = mapRunToOtlp(input)
    expect(validateTrace(input, trace)).toEqual([])
    const chats = trace.resourceSpans[0]!.scopeSpans[0]!.spans.filter((span) =>
      span.name.startsWith('chat '),
    )
    expect(chats).toHaveLength(1)
  })

  it('用量不一致时校验失败', () => {
    const input = source()
    const trace = mapRunToOtlp(input)
    const broken = structuredClone(trace)
    const chat = broken.resourceSpans[0]!.scopeSpans[0]!.spans.find((span) =>
      span.name.startsWith('chat '),
    )!
    const usage = chat.attributes.find((item) => item.key === 'gen_ai.usage.input_tokens')!
    usage.value = { intValue: '1' }
    expect(validateTrace(input, broken).some((item) => item.includes('输入 token'))).toBe(true)
  })
})
