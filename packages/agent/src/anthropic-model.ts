/**
 * Anthropic 真实模型适配器 原生 tool calling 加流式
 *
 * 工具走 messages API 的 tools 参数 工具参数经 input_json_delta 增量流出
 * 上下文消息以原生内容块回传 assistant 轮带 tool_use user 轮带 tool_result
 * 停止原因与用量来自 finalMessage 错误映射沿用统一错误码
 */

import Anthropic from '@anthropic-ai/sdk'
import { createToolError } from '@aftersales/contracts'
import { DomainError } from '@aftersales/domain'
import type {
  ChatModel,
  ContextBlock,
  ModelInfo,
  ModelMessage,
  ModelRequest,
  ModelStreamEvent,
  ModelUsage,
  ToolDefinition,
} from './model.js'

/** 默认使用 claude-sonnet-5 售后对话不需要 opus 级推理 可通过环境变量切换 */
const DEFAULT_MODEL = 'claude-sonnet-5'
const MAX_TOKENS = 8192

export interface AnthropicModelOptions {
  apiKey?: string
  /** 自定义服务地址 用于代理或中转站 缺省官方 api.anthropic.com */
  baseUrl?: string
  model?: string
}

export class AnthropicModel implements ChatModel {
  readonly info: ModelInfo
  private readonly client: Anthropic

  constructor(options: AnthropicModelOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      throw new DomainError(
        createToolError(
          'VALIDATION_ERROR',
          '未配置 ANTHROPIC_API_KEY 无法使用真实模型 请使用脚本化模型或配置密钥',
        ),
      )
    }
    const baseUrl = options.baseUrl ?? process.env.ANTHROPIC_BASE_URL
    this.client = new Anthropic({ apiKey, baseURL: baseUrl })
    this.info = {
      provider: 'anthropic',
      model: options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
    }
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const stream = this.client.messages.stream({
      model: this.info.model,
      max_tokens: request.maxTokens ?? MAX_TOKENS,
      system: request.system,
      messages: request.messages.map((message) => this.toProviderMessage(message)),
      tools: request.tools.map((tool) => this.toProviderTool(tool)),
    })

    try {
      // block index 到 tool_use id 的映射 input_json_delta 事件只带 index
      const toolCallIdByIndex = new Map<number, string>()
      for await (const event of stream) {
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          toolCallIdByIndex.set(event.index, event.content_block.id)
          yield {
            type: 'tool_call_start',
            toolCallId: event.content_block.id,
            toolName: event.content_block.name,
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: event.delta.text }
          } else if (event.delta.type === 'input_json_delta') {
            const toolCallId = toolCallIdByIndex.get(event.index)
            if (toolCallId) {
              yield {
                type: 'tool_input_delta',
                toolCallId,
                partialJson: event.delta.partial_json,
              }
            }
          }
        }
      }

      const final = await stream.finalMessage()
      yield { type: 'turn_completed', stopReason: this.mapStopReason(final.stop_reason), usage: this.toUsage(final.usage) }
    } catch (error) {
      throw this.mapError(error)
    }
  }

  private mapStopReason(
    reason: Anthropic.Message['stop_reason'],
  ): 'end_turn' | 'tool_use' | 'max_tokens' {
    if (reason === 'tool_use') return 'tool_use'
    if (reason === 'max_tokens') return 'max_tokens'
    return 'end_turn'
  }

  private toUsage(usage: Anthropic.Message['usage']): ModelUsage {
    return {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      costUsd: null,
    }
  }

  /** 原生内容块映射 text 与 tool_use tool_result 由 user 消息承载 */
  private toProviderMessage(message: ModelMessage): Anthropic.MessageParam {
    const content: Anthropic.ContentBlockParam[] = message.content.map((block) =>
      this.toProviderBlock(block),
    )
    return { role: message.role, content }
  }

  private toProviderBlock(block: ContextBlock): Anthropic.ContentBlockParam {
    if (block.type === 'text') {
      return { type: 'text', text: block.text }
    }
    if (block.type === 'tool_use') {
      return {
        type: 'tool_use',
        id: block.toolCallId,
        name: block.toolName,
        input: block.input,
      }
    }
    return {
      type: 'tool_result',
      tool_use_id: block.toolCallId,
      content: block.content,
      is_error: block.isError || undefined,
    }
  }

  private toProviderTool(tool: ToolDefinition): Anthropic.Tool {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }
  }

  /** SDK 类型化错误映射为统一错误码 具体类名从最特殊到一般 */
  private mapError(error: unknown): DomainError {
    if (error instanceof Anthropic.RateLimitError) {
      return new DomainError(createToolError('RATE_LIMITED', '模型服务限流 请稍后重试'))
    }
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return new DomainError(createToolError('TIMEOUT', '模型服务连接超时'))
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return new DomainError(createToolError('TIMEOUT', '模型服务连接失败'))
    }
    if (error instanceof Anthropic.APIError && error.status !== undefined) {
      return new DomainError(createToolError('UPSTREAM_ERROR', `模型服务异常 ${error.status}`))
    }
    return new DomainError(
      createToolError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error)),
    )
  }
}
