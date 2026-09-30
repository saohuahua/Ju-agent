import { expect, it } from 'vitest'
import {
  customerMessages,
  customerProcessing,
  type PendingCustomerMessage,
} from '../src/components/customer/customer-messages'
import { initialViewState, reduceEvent, reduceEvents } from '../src/lib/runReducer'
import type { AgentEvent } from '../src/lib/types'

const event = (sequence: number, type: string, payload: Record<string, unknown>): AgentEvent => ({
  runId: 'run-a',
  sequence,
  type,
  payload,
  createdAt: '2026-09-28T00:00:00Z',
})
const pending = (requestKey = 'key-a', runId: string | null = null): PendingCustomerMessage => ({
  requestKey,
  runId,
  text: '同一段消息',
  delivery: 'sending',
})

it('新版咨询和人工关联由公开事件恢复 下一回合清除旧选项', () => {
  const state = reduceEvents(initialViewState(), [
    event(1, 'run.paused', { reason: 'awaiting_input', consultation: 'ready' }),
    event(2, 'human.requested', { sourceRunId: 'original-run' }),
  ])
  expect(customerProcessing(state)).toBe('您可以继续提问或结束本次咨询')
  expect(state.sourceRunId).toBe('original-run')
  const choices = reduceEvent(
    state,
    event(3, 'run.paused', {
      reason: 'awaiting_input',
      consultation: 'clarify',
      showChoices: true,
    }),
  )
  expect(choices.showChoices).toBe(true)
  const resumed = reduceEvent(choices, event(4, 'run.resumed', {}))
  expect(resumed.showChoices).toBe(false)
  expect(resumed.consultation).toBeNull()
})

it('HTTP 尚未返回时立即显示用户消息且不宣称已受理', () => {
  expect(customerMessages([], [pending()], null)).toEqual([
    { role: 'user', text: '同一段消息', requestKey: 'key-a', delivery: 'sending' },
  ])
})
it.each(['sending', 'accepted', 'unknown', 'failed'] as const)(
  '后台事件先到时替换 %s 本地消息并以后台脱敏文本为准',
  (delivery) => {
    const state = reduceEvent(
      initialViewState(),
      event(4, 'message.user', { text: '后台文本', requestKey: 'key-a' }),
    )
    expect(
      customerMessages(state.messages, [{ ...pending('key-a', 'run-a'), delivery }], 'run-a'),
    ).toEqual([{ role: 'user', text: '后台文本', requestKey: 'key-a' }])
  },
)
it('相同文本不同请求分别显示 旧消息不按文本误确认', () => {
  const state = reduceEvents(initialViewState(), [
    event(1, 'message.user', { text: '同一段消息' }),
    event(4, 'message.user', { text: '同一段消息', requestKey: 'key-a' }),
    event(7, 'message.user', { text: '同一段消息', requestKey: 'key-b' }),
  ])
  const messages = customerMessages(state.messages, [pending('key-c', 'run-a')], 'run-a')
  expect(messages).toHaveLength(4)
  expect(messages.at(-1)?.delivery).toBe('sending')
})
it('重复请求事件和乱序批量回放不重复 确认序号允许跳跃', () => {
  const values = [
    event(7, 'message.user', { text: '消息', requestKey: 'key-a' }),
    event(2, 'message.user', { text: '消息', requestKey: 'key-a' }),
  ]
  const state = reduceEvents(initialViewState(), [...values, ...values])
  expect(state.messages).toHaveLength(1)
  expect(state.lastSequence).toBe(7)
})
it('切换会话不显示上一会话的未确认消息', () => {
  expect(customerMessages([], [pending('key-a', 'run-a')], 'run-b')).toEqual([])
})
it('未知发送与明确失败保持各自状态 重试同键只留下一个本地条目', () => {
  for (const delivery of ['unknown', 'failed'] as const) {
    expect(customerMessages([], [{ ...pending(), delivery }], null)[0]?.delivery).toBe(delivery)
  }
})
it('工具开始结果按执行标识配对 新回合不把历史结果作为当前进度', () => {
  let state = reduceEvent(initialViewState(), event(1, 'run.started', {}))
  expect(customerProcessing(state)).toContain('已受理')
  state = reduceEvent(
    state,
    event(4, 'tool.requested', { executionId: 'action-a', toolName: 'list_my_orders' }),
  )
  expect(customerProcessing(state)).toBe('正在查询最近订单')
  state = reduceEvent(
    state,
    event(7, 'tool.completed', {
      executionId: 'action-a',
      toolName: 'list_my_orders',
      status: 'succeeded',
    }),
  )
  expect(state.tools).toHaveLength(1)
  expect(customerProcessing(state)).toContain('已完成')
  state = reduceEvent(state, event(9, 'run.resumed', {}))
  expect(state.tools).toHaveLength(1)
  expect(customerProcessing(state)).toContain('已受理')
})
it('失败工具等待补充和运行失败不显示虚构成功', () => {
  let state = reduceEvents(initialViewState(), [
    event(1, 'run.started', {}),
    event(2, 'tool.completed', { toolName: 'search_policy', status: 'failed' }),
  ])
  expect(customerProcessing(state)).toContain('未成功')
  state = reduceEvent(state, event(4, 'run.paused', { reason: 'awaiting_input' }))
  expect(customerProcessing(state)).toBe('等待您补充信息')
  state = reduceEvent(state, event(7, 'run.failed', {}))
  expect(customerProcessing(state)).toBe('处理暂时中断')
})
