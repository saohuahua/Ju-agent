import { ScriptedModel, PROMPT_VERSION, type ModelStreamEvent } from '@aftersales/agent'
import type { AgentOutput, EvalCase } from '@aftersales/contracts'
import { conversationDemoOptions, createP7Snapshot, type P7Transport } from '@aftersales/runtime'
import type { P7EvalModelsInput, P7EvalRole } from './p7-eval-models.js'
import { STOP_SENTINEL } from './simulator.js'

/** 将确定性脚本回放成原生事件用于正式离线入口 不访问网络或宣称模型质量 */
function transport(events: () => AsyncIterable<ModelStreamEvent>): P7Transport {
  return {
    mode: 'simulation',
    async *stream(_body, signal) {
      signal.throwIfAborted()
      yield { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }
      let index = 0
      let current: number | undefined
      let stopReason = 'end_turn'
      for await (const event of events()) {
        signal.throwIfAborted()
        if (event.type === 'tool_call_start') {
          if (current !== undefined) yield { type: 'content_block_stop', index: current }
          current = index++
          yield {
            type: 'content_block_start',
            index: current,
            content_block: {
              type: 'tool_use',
              id: event.toolCallId,
              name: event.toolName,
              input: {},
            },
          }
        } else if (event.type === 'tool_input_delta') {
          yield {
            type: 'content_block_delta',
            index: current,
            delta: { type: 'input_json_delta', partial_json: event.partialJson },
          }
        } else if (event.type === 'text_delta') {
          if (current !== undefined) {
            yield { type: 'content_block_stop', index: current }
            current = undefined
          }
          const textIndex = index++
          yield {
            type: 'content_block_start',
            index: textIndex,
            content_block: { type: 'text', text: '' },
          }
          yield {
            type: 'content_block_delta',
            index: textIndex,
            delta: { type: 'text_delta', text: event.text },
          }
          yield { type: 'content_block_stop', index: textIndex }
        } else stopReason = event.stopReason
      }
      if (current !== undefined) yield { type: 'content_block_stop', index: current }
      yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason },
        usage: { output_tokens: 1 },
      }
      yield { type: 'message_stop' }
    },
  }
}

/** 人工固定价格与人工 usage 只用于预算通路验收 不代表供应商计费 */
export function offlineEvalRoles(testCase: EvalCase): P7EvalModelsInput['roles'] {
  const scripted = new ScriptedModel(testCase.modelScript as AgentOutput[])
  let turn = 0
  const texts = async function* (text: string): AsyncIterable<ModelStreamEvent> {
    yield { type: 'text_delta', text }
    yield {
      type: 'turn_completed',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
    }
  }
  const transports = {
    main_agent: transport(() => scripted.stream({ system: '', messages: [], tools: [] })),
    simulator: transport(() => texts(testCase.turns[turn++]?.userMessage ?? STOP_SENTINEL)),
    // 离线 Judge 明确报告未评估 不把脚本返回包装成主观质量通过
    judge: transport(() =>
      texts(
        JSON.stringify(
          (testCase.assertions.judgeRubric ?? []).map((rubric) => ({
            rubric,
            passed: false,
            reason: '离线脚本不评估主观质量',
          })),
        ),
      ),
    ),
  }
  const { version: _version, ...base } = conversationDemoOptions().snapshot
  const role = (name: P7EvalRole) => ({
    snapshot: createP7Snapshot({
      ...base,
      model: `offline-${name}`,
      promptVersion: PROMPT_VERSION,
      capabilities: {
        ...base.capabilities,
        parallelTools: true,
        contextTokens: 200000,
        maxOutputTokens: 4000,
      },
      maxOutputTokens: 4000,
      timeoutMs: 5000,
      price: {
        ...base.price!,
        version: 'synthetic-eval-fixed-v1',
        fixedMicroPerCall: 10,
        source: 'synthetic offline eval fixed price',
      },
    }),
    transport: transports[name],
  })
  return { main_agent: role('main_agent'), simulator: role('simulator'), judge: role('judge') }
}
