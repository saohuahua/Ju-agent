import { afterEach, expect, it, vi } from 'vitest'
import type * as AnthropicModule from '@anthropic-ai/sdk'
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
