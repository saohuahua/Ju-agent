/**
 * Provider 无关的流式模型接口
 *
 * 原生 tool calling 协议 工具以目录形式随请求下发 流式事件逐个产出
 * ScriptedModel 与 AnthropicModel 同构 离线评测与真实模型共享同一循环
 * 上下文消息采用原生内容块 assistant 轮携带 tool_use user 轮携带 tool_result
 */

export interface ModelInfo {
  provider: string
  model: string
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  /** 成本估算美元 无数据时为空 */
  costUsd: number | null
}

/** 下发给模型的工具定义 inputSchema 为 JSON Schema */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** 模型轮次产出的内容块 */
export type AssistantBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use'
      toolCallId: string
      toolName: string
      input: Record<string, unknown>
      thoughtSignature?: number[]
    }

/** 回灌给模型的历史内容块 */
export type ContextBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use'
      toolCallId: string
      toolName: string
      input: Record<string, unknown>
      thoughtSignature?: number[]
    }
  | {
      type: 'tool_result'
      toolCallId: string
      toolName: string
      content: string
      isError: boolean
    }

/** 原生协议消息 user 轮含文本与 tool_result assistant 轮含文本与 tool_use */
export interface ModelMessage {
  role: 'user' | 'assistant'
  content: ContextBlock[]
}

export interface ModelRequest {
  system: string
  messages: ModelMessage[]
  tools: ToolDefinition[]
  maxTokens?: number
}

/** 模型流式事件 与提供商 SSE 语义对齐 */
export type ModelStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string; thoughtSignature?: number[] }
  | { type: 'tool_input_delta'; toolCallId: string; partialJson: string }
  | {
      type: 'turn_completed'
      stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
      usage: ModelUsage
    }

export interface ChatModel {
  readonly info: ModelInfo
  /** 声明取消后流会完成收尾 供调用方安全等待 */
  readonly supportsCancellation?: true
  /** 支持取消的适配器应在信号终止后完成流的收尾 */
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>
}

/** 脚本耗尽 评测脚本与实际调用次数不匹配时抛出 */
export class ScriptExhaustedError extends Error {
  constructor() {
    super('脚本化模型输出已耗尽 用例脚本与运行轨迹不匹配')
    this.name = 'ScriptExhaustedError'
  }
}
