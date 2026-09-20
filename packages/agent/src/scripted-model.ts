/**
 * 脚本化模型
 *
 * 离线评测的确定性模型 按调用顺序吐出预设输出
 * 脚本与真实轨迹不匹配立即暴露 是轨迹回归的第一道哨兵
 */

import type { AgentOutput } from '@aftersales/contracts'
import {
  type ChatModel,
  type ModelInfo,
  type ModelRequest,
  type ModelResult,
  ScriptExhaustedError,
} from './model.js'

export const SCRIPTED_MODEL_INFO: ModelInfo = { provider: 'scripted', model: 'scripted-v1' }

export class ScriptedModel implements ChatModel {
  readonly info: ModelInfo = SCRIPTED_MODEL_INFO
  private cursor = 0
  /** 已消耗次数 供评测断言模型调用次数 */
  callCount = 0

  constructor(private readonly script: AgentOutput[]) {}

  async complete(_request: ModelRequest): Promise<ModelResult> {
    this.callCount += 1
    const output = this.script[this.cursor]
    this.cursor += 1
    if (!output) {
      throw new ScriptExhaustedError()
    }
    return {
      raw: JSON.stringify(output),
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    }
  }
}
