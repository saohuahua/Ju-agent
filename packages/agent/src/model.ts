/**
 * Provider 无关的模型接口
 *
 * 运行时只依赖这个接口 ScriptedModel 与 AnthropicModel 同构
 * 评测离线可复现 真实模型可选接入 两者共享同一套提示词与校验
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

/** 模型上下文消息 tool_result 由适配层映射到目标协议 */
export interface ModelMessage {
  role: 'user' | 'assistant' | 'tool_result'
  toolName?: string
  content: string
}

export interface ModelRequest {
  system: string
  messages: ModelMessage[]
  maxTokens?: number
}

export interface ModelResult {
  /** 模型原始输出文本 由调用方做结构化校验 */
  raw: string
  usage: ModelUsage
}

export interface ChatModel {
  readonly info: ModelInfo
  complete(request: ModelRequest): Promise<ModelResult>
}

/** 脚本耗尽 评测脚本与实际调用次数不匹配时抛出 */
export class ScriptExhaustedError extends Error {
  constructor() {
    super('脚本化模型输出已耗尽 用例脚本与运行轨迹不匹配')
    this.name = 'ScriptExhaustedError'
  }
}
