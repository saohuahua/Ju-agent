/**
 * Anthropic 真实模型适配器
 *
 * 结构化输出走系统提示词约束加运行时 Zod 校验失败一轮修复
 * 不使用各家私有的结构化输出参数 保证与 ScriptedModel 行为对称
 * 错误映射为统一错误码 上层重试与转人工策略不感知具体 SDK
 */

import Anthropic from '@anthropic-ai/sdk'
import { createToolError } from '@aftersales/contracts'
import { DomainError } from '@aftersales/domain'
import type { ChatModel, ModelInfo, ModelRequest, ModelResult } from './model.js'

/** 默认使用 claude-opus-5 可通过环境变量切换模型做成本与质量对比 */
const DEFAULT_MODEL = 'claude-opus-5'
const MAX_TOKENS = 8192

export interface AnthropicModelOptions {
  apiKey?: string
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
    this.client = new Anthropic({ apiKey })
    this.info = {
      provider: 'anthropic',
      model: options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
    }
  }

  async complete(request: ModelRequest): Promise<ModelResult> {
    try {
      const response = await this.client.messages.create({
        model: this.info.model,
        max_tokens: request.maxTokens ?? MAX_TOKENS,
        system: request.system,
        messages: request.messages.map((message) => this.toProviderMessage(message)),
      })
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')
      return {
        raw: text,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          costUsd: null,
        },
      }
    } catch (error) {
      throw this.mapError(error)
    }
  }

  /** 内部消息映射到 Anthropic 协议 tool_result 以用户消息承载并明确标注来源 */
  private toProviderMessage(message: ModelRequest['messages'][number]): Anthropic.MessageParam {
    if (message.role === 'tool_result') {
      return {
        role: 'user',
        content: `[系统工具结果 ${message.toolName ?? 'tool'}] ${message.content}`,
      }
    }
    return { role: message.role, content: message.content }
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
