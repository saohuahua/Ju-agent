import { afterEach, expect, it, vi } from 'vitest'
import type * as AnthropicModule from '@anthropic-ai/sdk'
import { rebuildMessages } from '@aftersales/agent'
import { redactDeep } from '@aftersales/domain'
import { createLiveTransport } from '../src/p7-live-transport.js'
import { decodeP7Stream, encodeP7Request } from '../src/p7-protocol.js'
import { createP7Snapshot } from '../src/p7-snapshot.js'
import { config, frames, request } from './p7-fixtures.js'

// 旧版 SDK 默认使用独立 fetch 测试固定使用本地响应替身
vi.mock('@anthropic-ai/sdk', async (original) => {
  const module = await original<typeof AnthropicModule>()
  return {
    ...module,
    default: class extends module.default {
      constructor(options: ConstructorParameters<typeof module.default>[0]) {
        super({ ...options, fetch: globalThis.fetch })
      }
    },
  }
})

afterEach(() => vi.unstubAllGlobals())

it.each(['anthropic_messages', 'openai_chat'] as const)(
  '%s DeepSeek 官方请求关闭默认思考以匹配当前会话契约',
  async (protocol) => {
    let sent: Record<string, unknown> = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        sent = JSON.parse(String(init.body)) as Record<string, unknown>
        const disabled = (sent.thinking as { type?: string } | undefined)?.type === 'disabled'
        const values = disabled
          ? frames(protocol)
          : protocol === 'anthropic_messages'
            ? [
                ...frames(protocol).slice(0, 1),
                {
                  type: 'content_block_start',
                  index: 0,
                  content_block: { type: 'thinking', thinking: '' },
                },
              ]
            : frames(protocol, { text: '', truncated: true })
        const body =
          values
            .map((value) => {
              const name =
                protocol === 'anthropic_messages' &&
                value &&
                typeof value === 'object' &&
                'type' in value
                  ? `event: ${(value as { type: string }).type}\n`
                  : ''
              return `${name}data: ${JSON.stringify(value)}\n\n`
            })
            .join('') + (protocol === 'openai_chat' ? 'data: [DONE]\n\n' : '')
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      }),
    )
    const snapshot = createP7Snapshot(config({ protocol, mode: 'live' }))
    const transport = createLiveTransport({
      protocol,
      baseUrl:
        protocol === 'anthropic_messages'
          ? 'https://api.deepseek.com/anthropic'
          : 'https://api.deepseek.com',
      apiKey: 'fixture-key',
    })
    const result = await decodeP7Stream(
      transport.stream(encodeP7Request(request, snapshot), new AbortController().signal),
      request,
      snapshot,
      () => undefined,
    )
    expect(sent.thinking).toEqual({ type: 'disabled' })
    expect(result.events).toEqual([{ type: 'text_delta', text: '你好' }])
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  },
)

it('其他提供商不附加 DeepSeek 扩展参数', async () => {
  let sent: Record<string, unknown> = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }),
  )
  const transport = createLiveTransport({
    protocol: 'openai_chat',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'fixture-key',
  })
  for await (const event of transport.stream(
    { model: 'fixture', stream: true },
    new AbortController().signal,
  )) {
    void event
  }
  expect(sent).not.toHaveProperty('thinking')
})

it('Gemini 重复流式用量只在完成后结算一次', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"连接成功"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n' +
          'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n' +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    ),
  )
  const snapshot = createP7Snapshot(config({ protocol: 'openai_chat', mode: 'live' }))
  const transport = createLiveTransport({
    protocol: 'openai_chat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKey: 'fixture-key',
  })
  const result = await decodeP7Stream(
    transport.stream(encodeP7Request(request, snapshot), new AbortController().signal),
    request,
    snapshot,
    () => undefined,
  )
  expect(result.events).toEqual([{ type: 'text_delta', text: '连接成功' }])
  expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2 })
})

it('Gemini 工具调用缺少分片索引时补齐索引', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"id\\":\\"O1\\"}"},"extra_content":{"google":{"thought_signature":"sig-13812345678"}}}]}}],"usage":{"prompt_tokens":10,"completion_tokens":12}}\n\n' +
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":12}}\n\n' +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    ),
  )
  const snapshot = createP7Snapshot(config({ protocol: 'openai_chat', mode: 'live' }))
  const transport = createLiveTransport({
    protocol: 'openai_chat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKey: 'fixture-key',
  })
  const result = await decodeP7Stream(
    transport.stream(encodeP7Request(request, snapshot), new AbortController().signal),
    request,
    snapshot,
    () => undefined,
  )
  expect(result.events).toEqual([
    {
      type: 'tool_call_start',
      toolCallId: 'call_1',
      toolName: 'lookup',
      thoughtSignature: [...Buffer.from('sig-13812345678')],
    },
    { type: 'tool_input_delta', toolCallId: 'call_1', partialJson: '{"id":"O1"}' },
  ])
  expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 12 })

  const turn = redactDeep({
    blocks: [
      {
        type: 'tool_use',
        toolCallId: 'call_1',
        toolName: 'lookup',
        input: { id: 'O1' },
        thoughtSignature: [...Buffer.from('sig-13812345678')],
      },
    ],
  })
  const messages = rebuildMessages([
    { type: 'message.user', payload: { text: '查询订单' } },
    { type: 'agent.turn', payload: turn },
    {
      type: 'agent.tool_results',
      payload: { results: [{ toolCallId: 'call_1', toolName: 'lookup', content: '{}', isError: false }] },
    },
  ])
  const next = encodeP7Request({ ...request, messages }, snapshot) as {
    messages: Array<{ tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }>
  }
  expect(next.messages[2]?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe(
    'sig-13812345678',
  )
})

it('其他兼容提供商的扩展字段不被当作 Gemini 签名', async () => {
  const snapshot = createP7Snapshot(config({ protocol: 'openai_chat', mode: 'live' }))
  const source = async function* () {
    yield {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                function: { name: 'lookup', arguments: '{"id":"O1"}' },
                extra_content: { vendor: { marker: 'supported' } },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }
    yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: 12 } }
  }
  const result = await decodeP7Stream(source(), request, snapshot, () => undefined)
  expect(result.events).toEqual([
    { type: 'tool_call_start', toolCallId: 'call_1', toolName: 'lookup' },
    { type: 'tool_input_delta', toolCallId: 'call_1', partialJson: '{"id":"O1"}' },
  ])
})
