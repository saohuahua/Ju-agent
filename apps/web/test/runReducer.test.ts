/**
 * 事件归约器测试
 *
 * 归约器是工作台状态重建的唯一逻辑 覆盖流式拼接 序号去重与终态
 */

import { describe, expect, it } from 'vitest'
import { formatAmount, initialViewState, reduceEvent, reduceEvents } from '../src/lib/runReducer'
import type { AgentEvent } from '../src/lib/types'

function event(sequence: number, type: string, payload: Record<string, unknown>): AgentEvent {
  return { runId: 'run_t', sequence, type, payload, createdAt: '2026-09-20T12:00:00.000Z' }
}

describe('事件归约', () => {
  it('用户与助手消息按序进入列表', () => {
    let state = initialViewState()
    state = reduceEvent(state, event(1, 'message.user', { text: '查单' }))
    state = reduceEvent(state, event(2, 'message.delta', { textDelta: '订单' }))
    state = reduceEvent(state, event(3, 'message.delta', { textDelta: '在途' }))
    state = reduceEvent(
      state,
      event(4, 'message.completed', { role: 'assistant', text: '订单在途中' }),
    )
    expect(state.messages).toHaveLength(2)
    expect(state.messages[0]).toEqual({ role: 'user', text: '查单' })
    expect(state.messages[1]).toEqual({ role: 'assistant', text: '订单在途中', streaming: false })
  })

  it('completed 事件覆盖增量拼接结果 保证重放幂等', () => {
    let state = initialViewState()
    state = reduceEvent(state, event(1, 'message.delta', { textDelta: '片段一' }))
    state = reduceEvent(
      state,
      event(2, 'message.completed', { role: 'assistant', text: '完整回复' }),
    )
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.text).toBe('完整回复')
    expect(state.messages[0]?.streaming).toBe(false)
  })

  it('重复或回退的序号被忽略 SSE 重连不产生重复', () => {
    let state = initialViewState()
    state = reduceEvent(state, event(1, 'message.user', { text: 'a' }))
    state = reduceEvent(state, event(1, 'message.user', { text: 'a' }))
    state = reduceEvent(state, event(1, 'message.user', { text: 'a' }))
    expect(state.messages).toHaveLength(1)
    expect(state.lastSequence).toBe(1)
  })

  it('工具请求与结果配对更新', () => {
    let state = initialViewState()
    state = reduceEvent(
      state,
      event(1, 'tool.requested', {
        executionId: 'e1',
        toolName: 'get_order',
        attempt: 1,
        args: {},
      }),
    )
    expect(state.tools[0]?.status).toBe('pending')
    state = reduceEvent(
      state,
      event(2, 'tool.completed', {
        executionId: 'e1',
        toolName: 'get_order',
        status: 'succeeded',
        latencyMs: 12,
      }),
    )
    expect(state.tools[0]?.status).toBe('succeeded')
    expect(state.tools[0]?.latencyMs).toBe(12)
  })

  it('审批事件更新卡片状态', () => {
    let state = initialViewState()
    state = reduceEvent(
      state,
      event(1, 'approval.required', {
        approvalId: 'a1',
        resourceId: 'RT-1',
        amountCents: 699900,
        reason: '大额',
      }),
    )
    expect(state.approvals[0]?.status).toBe('pending')
    state = reduceEvent(
      state,
      event(2, 'approval.decided', { approvalId: 'a1', decision: 'approved', decidedBy: 's' }),
    )
    expect(state.approvals[0]?.status).toBe('approved')
  })

  it('终态事件更新运行状态', () => {
    let state = initialViewState()
    state = reduceEvent(state, event(1, 'run.started', {}))
    state = reduceEvent(state, event(2, 'run.paused', { reason: 'awaiting_approval' }))
    expect(state.status).toBe('awaiting_approval')
    state = reduceEvent(state, event(3, 'run.resumed', { resumePoint: 'approval' }))
    state = reduceEvent(state, event(4, 'run.completed', { summary: '完成', escalated: false }))
    expect(state.status).toBe('completed')
  })

  it('乱序事件按序号排序后归约', () => {
    const state = reduceEvents(initialViewState(), [
      event(2, 'message.completed', { role: 'assistant', text: '回复' }),
      event(1, 'message.user', { text: '提问' }),
    ])
    expect(state.messages[0]?.role).toBe('user')
  })

  it('金额展示分转元', () => {
    expect(formatAmount(699900)).toBe('¥6999.00')
    expect(formatAmount(8900)).toBe('¥89.00')
  })
})
