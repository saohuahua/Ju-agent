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
  const deepSeek = new URL(settings.baseUrl).hostname === 'api.deepseek.com'
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
      for await (const event of response) yield event
    },
  }
}
