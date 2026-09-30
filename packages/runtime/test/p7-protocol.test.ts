import { describe, expect, it } from 'vitest'
import { createP7Snapshot } from '../src/p7-snapshot.js'
import { decodeP7Stream, encodeP7Request } from '../src/p7-protocol.js'
import { config, frames, request, streamFrames } from './p7-fixtures.js'
import type { ModelRequest } from '../../agent/src/model.js'

describe.each(['anthropic_messages', 'openai_chat'] as const)('%s 协议', (protocol) => {
  const snapshot = createP7Snapshot(config({ protocol }))
  const decode = (values: unknown[]) =>
    decodeP7Stream(streamFrames(values), request, snapshot, () => undefined)

  it('普通文字与可核验用量', async () => {
    const result = await decode(frames(protocol))
    expect(result.events).toEqual([{ type: 'text_delta', text: '你好' }])
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })
  it.each([1, 2])('完整工具参数与多工具 %i', async (tools) => {
    const result = await decode(frames(protocol, { tools }))
    expect(result.events.filter((e) => e.type === 'tool_call_start')).toHaveLength(tools)
    expect(
      result.events
        .filter((e) => e.type === 'tool_input_delta')
        .map((e) => JSON.parse(e.partialJson)),
    ).toEqual(Array.from({ length: tools }, () => ({ id: 'O1' })))
    expect(result.stopReason).toBe('tool_use')
  })
  it.each([
    ['不完整 JSON', { tools: 1, json: ['{"id":'] }, 'PROTOCOL'],
    ['错误工具名', { tools: 1, toolName: 'refund_without_approval' }, 'PROTOCOL'],
    ['重复工具标识', { tools: 2, duplicate: true }, 'PROTOCOL'],
    ['空结果', { text: '' }, 'EMPTY'],
    ['截断', { truncated: true }, 'TRUNCATED'],
  ] as const)('%s', async (_name, options, code) => {
    await expect(decode(frames(protocol, options))).rejects.toMatchObject({ code })
  })
  it('缺失用量保留未知', async () => {
    expect((await decode(frames(protocol, { missingUsage: true }))).usage).toBeNull()
  })
  it('流中断不能伪装成功', async () => {
    const values = frames(protocol)
    await expect(
      decode(values.slice(0, protocol === 'openai_chat' ? -2 : -1)),
    ).rejects.toMatchObject({ code: 'CONNECTION' })
  })
  it('非法分片对应不存在的工具', async () => {
    const bad =
      protocol === 'anthropic_messages'
        ? [
            {
              type: 'content_block_delta',
              index: 77,
              delta: { type: 'input_json_delta', partial_json: '{}' },
            },
          ]
        : [
            {
              choices: [
                { index: 0, delta: { tool_calls: [{ index: 77, function: { arguments: '{}' } }] } },
              ],
            },
          ]
    await expect(decode(bad)).rejects.toMatchObject({ code: 'PROTOCOL' })
  })
  it('工具回灌与协议请求映射', () => {
    const history: ModelRequest = {
      ...request,
      messages: [
        ...request.messages,
        {
          role: 'assistant',
          content: [{ type: 'tool_use', toolCallId: 't', toolName: 'lookup', input: { id: 'O1' } }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolCallId: 't',
              toolName: 'lookup',
              content: 'ok',
              isError: false,
            },
          ],
        },
      ],
    }
    const body = encodeP7Request(history, snapshot)
    expect(body.model).toBe(snapshot.model)
    expect(body.max_tokens).toBe(snapshot.maxOutputTokens)
    expect(JSON.stringify(body)).toContain(
      protocol === 'openai_chat' ? 'tool_call_id' : 'tool_use_id',
    )
  })
  it.each(['missing', 'duplicate', 'name'] as const)('拒绝不匹配历史 %s', (kind) => {
    const result = {
      type: 'tool_result' as const,
      toolCallId: kind === 'missing' ? 'wrong' : 't',
      toolName: kind === 'name' ? 'wrong' : 'lookup',
      content: 'ok',
      isError: false,
    }
    const history: ModelRequest = {
      ...request,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', toolCallId: 't', toolName: 'lookup', input: {} }],
        },
        { role: 'user', content: kind === 'duplicate' ? [result, result] : [result] },
      ],
    }
    expect(() => encodeP7Request(history, snapshot)).toThrow('PROTOCOL')
  })
  it('能力不支持多工具时拒绝', async () => {
    const restricted = createP7Snapshot(
      config({ protocol, capabilities: { ...snapshot.capabilities, parallelTools: false } }),
    )
    await expect(
      decodeP7Stream(
        streamFrames(frames(protocol, { tools: 2 })),
        request,
        restricted,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'PROTOCOL' })
  })
})
