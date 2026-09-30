import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { P7Config } from '@aftersales/contracts'
import type { P7Transport } from './p7-gateway.js'

export interface LiveTransportSettings {
  protocol: P7Config['protocol']
  baseUrl: string
  apiKey: string
}

export function createLiveTransport(settings: LiveTransportSettings): P7Transport {
  // 当前消息契约不回传推理块 DeepSeek 官方请求显式关闭默认思考
  const hostname = new URL(settings.baseUrl).hostname
  const deepSeek = hostname === 'api.deepseek.com'
  const gemini = hostname === 'generativelanguage.googleapis.com'
  const requestBody = (body: Record<string, unknown>) =>
    deepSeek ? { ...body, thinking: { type: 'disabled' } } : body
  if (settings.protocol === 'anthropic_messages') {
    const client = new Anthropic({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
      maxRetries: 0,
    })
    return {
      mode: 'live',
      async *stream(body, signal) {
        const response = await client.messages.create(
          requestBody(body) as unknown as Anthropic.MessageCreateParamsStreaming,
          { signal },
        )
        for await (const event of response) yield event
      },
    }
  }

  const client = new OpenAI({ apiKey: settings.apiKey, baseURL: settings.baseUrl, maxRetries: 0 })
  return {
    mode: 'live',
    async *stream(body, signal) {
      const response = await client.chat.completions.create(
        requestBody(body) as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        { signal },
      )
      let usage: OpenAI.Completions.CompletionUsage | undefined
      let toolCalled = false
      for await (const event of response) {
        if (!gemini) {
          yield event
          continue
        }
        if (event.usage) usage = event.usage
        const { usage: _usage, ...frame } = event
        yield {
          ...frame,
          choices: frame.choices.map((choice) => {
            if (choice.delta.tool_calls?.length) toolCalled = true
            return {
              ...choice,
              finish_reason:
                choice.finish_reason === 'stop' && toolCalled
                  ? 'tool_calls'
                  : choice.finish_reason,
              delta: {
                ...choice.delta,
                tool_calls: choice.delta.tool_calls?.map((call, position) => ({
                  ...call,
                  index: call.index ?? position,
                })),
              },
            }
          }),
        }
      }
      // Gemini 每个片段可能重复报告用量 只在末尾交给统一计费协议
      if (gemini && usage) yield { choices: [], usage }
    },
  }
}
