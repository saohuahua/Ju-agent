/**
 * 脚本化模型
 *
 * 离线评测的确定性模型 每个脚本条目对应一个模型轮次
 * 旧版五选一 JSON 输出经 convertScriptTurn 映射为原生工具调用事件流
 * 脚本与真实轨迹不匹配立即暴露 是轨迹回归的第一道哨兵
 */

import type { AgentOutput } from '@aftersales/contracts'
import { ASK_USER_TOOL } from './tool-defs.js'
import {
  type ChatModel,
  type ModelInfo,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelUsage,
  ScriptExhaustedError,
} from './model.js'

export const SCRIPTED_MODEL_INFO: ModelInfo = { provider: 'scripted', model: 'scripted-v1' }

const SCRIPTED_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }

/**
 * 旧版 AgentOutput 到原生轮次事件的转换
 *
 * kind 与新协议的映射
 *   tool_call -> 原生只读工具调用
 *   clarify   -> ask_user 协议工具
 *   action    -> 意图名工具 槽位加 reason 作为输入
 *   final     -> 纯文本轮 end_turn
 *   escalate  -> escalate 工具
 */
export function* convertScriptTurn(
  output: AgentOutput,
  toolCallId: string,
): Generator<ModelStreamEvent, void, unknown> {
  switch (output.kind) {
    case 'tool_call': {
      yield { type: 'tool_call_start', toolCallId, toolName: output.tool }
      yield { type: 'tool_input_delta', toolCallId, partialJson: JSON.stringify(output.args) }
      yield { type: 'turn_completed', stopReason: 'tool_use', usage: SCRIPTED_USAGE }
      break
    }
    case 'clarify': {
      yield { type: 'tool_call_start', toolCallId, toolName: ASK_USER_TOOL }
      yield {
        type: 'tool_input_delta',
        toolCallId,
        partialJson: JSON.stringify({
          question: output.question,
          missingSlot: output.missingSlots[0] ?? 'unknown',
        }),
      }
      yield { type: 'turn_completed', stopReason: 'tool_use', usage: SCRIPTED_USAGE }
      break
    }
    case 'action': {
      yield { type: 'tool_call_start', toolCallId, toolName: output.intent }
      yield {
        type: 'tool_input_delta',
        toolCallId,
        partialJson: JSON.stringify({ ...output.slots, explanation: output.reason }),
      }
      yield { type: 'turn_completed', stopReason: 'tool_use', usage: SCRIPTED_USAGE }
      break
    }
    case 'final': {
      if (output.answer) {
        yield { type: 'text_delta', text: output.answer }
      }
      yield { type: 'turn_completed', stopReason: 'end_turn', usage: SCRIPTED_USAGE }
      break
    }
    case 'escalate': {
      yield { type: 'tool_call_start', toolCallId, toolName: 'escalate' }
      yield { type: 'tool_input_delta', toolCallId, partialJson: JSON.stringify({ reason: output.reason }) }
      yield { type: 'turn_completed', stopReason: 'tool_use', usage: SCRIPTED_USAGE }
      break
    }
  }
}

export class ScriptedModel implements ChatModel {
  readonly info: ModelInfo = SCRIPTED_MODEL_INFO
  private cursor = 0
  /** 已消耗轮次数 供评测断言模型调用次数 */
  callCount = 0

  constructor(private readonly script: AgentOutput[]) {}

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.callCount += 1
    const output = this.script[this.cursor]
    const toolCallId = `script-${this.cursor}`
    this.cursor += 1
    if (!output) {
      throw new ScriptExhaustedError()
    }
    yield* convertScriptTurn(output, toolCallId)
  }
}
