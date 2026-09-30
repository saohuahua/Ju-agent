import { expect, it } from 'vitest'
import type { ChatModel } from '@aftersales/agent'
import { judgeTranscript } from '../src/judge.js'

// 合成输出仅验证判据协议
function model(raw: string): ChatModel {
  return {
    info: { provider: 'synthetic', model: 'synthetic' },
    async *stream() {
      yield { type: 'text_delta', text: raw }
      yield {
        type: 'turn_completed',
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
      }
    },
  }
}

it.each([
  '[]',
  '[{"rubric":"礼貌","passed":true}]',
  '[{"rubric":"礼貌","passed":true},{"rubric":"礼貌","passed":true}]',
  '[{"rubric":"礼貌","passed":true},{"rubric":"清晰","passed":"true"}]',
  '[{"rubric":"礼貌","passed":true},{"rubric":"其他","passed":true}]',
  '[{"rubric":"礼貌","passed":true,"reason":"非法"引号"},{"rubric":"清晰","passed":true}]',
])('不完整或非法 Judge 输出不得通过 %s', async (raw) => {
  expect(await judgeTranscript({ model: model(raw) }, ['礼貌', '清晰'], [])).not.toEqual([])
})

it('重复输入判据不得通过', async () => {
  expect(
    await judgeTranscript(
      { model: model('[{"rubric":"礼貌","passed":true}]') },
      ['礼貌', '礼貌'],
      [],
    ),
  ).not.toEqual([])
})

it('完整唯一判据允许主观项通过', async () => {
  expect(
    await judgeTranscript(
      { model: model('[{"rubric":"清晰","passed":true},{"rubric":"礼貌","passed":true}]') },
      ['礼貌', '清晰'],
      [],
    ),
  ).toEqual([])
})

it('Judge 超时和未完成输出均拒绝通过', async () => {
  const stalled: ChatModel = {
    info: { provider: 'synthetic', model: 'stalled' },
    async *stream() {
      yield { type: 'text_delta', text: '[]' }
      await new Promise(() => {})
    },
  }
  expect(await judgeTranscript({ model: stalled, timeoutMs: 5 }, ['礼貌'], [])).toEqual([
    { rubric: 'judge 超时', reason: '未获得完整判定' },
  ])
  const incomplete: ChatModel = {
    info: stalled.info,
    async *stream() {
      yield { type: 'text_delta', text: '[{"rubric":"礼貌","passed":true}]' }
    },
  }
  expect(await judgeTranscript({ model: incomplete }, ['礼貌'], [])).not.toEqual([])
})
