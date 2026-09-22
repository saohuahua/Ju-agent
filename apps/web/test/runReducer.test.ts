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

  it('物流事件进入独立列表 延误与丢件按状态归一', () => {
    let state = initialViewState()
    state = reduceEvent(
      state,
      event(1, 'logistics.event', {
        orderNo: 'SO-2026-0002',
        carrier: '顺丰',
        trackingNo: 'SF1357924680',
        status: 'delayed',
        description: '分拨中心积压',
        injectedAt: '2026-09-20T12:00:00.000Z',
      }),
    )
    state = reduceEvent(
      state,
      event(2, 'logistics.event', {
        orderNo: 'SO-2026-0002',
        carrier: '顺丰',
        trackingNo: 'SF1357924680',
        status: 'lost',
        description: '包裹丢失',
        injectedAt: '2026-09-20T13:00:00.000Z',
      }),
    )
    expect(state.logistics).toHaveLength(2)
    expect(state.logistics[0]).toEqual({
      orderNo: 'SO-2026-0002',
      carrier: '顺丰',
      trackingNo: 'SF1357924680',
      status: 'delayed',
      description: '分拨中心积压',
      injectedAt: '2026-09-20T12:00:00.000Z',
    })
    expect(state.logistics[1]?.status).toBe('lost')
    expect(state.messages).toHaveLength(0)
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

  it('人工接管事件链 升级 接管 坐席消息 客户留言 解决', () => {
    let state = initialViewState()
    state = reduceEvent(state, event(1, 'run.started', {}))
    state = reduceEvent(state, event(2, 'message.user', { text: '转人工' }))
    state = reduceEvent(state, event(3, 'run.escalated', { reason: '客户要求人工' }))
    expect(state.status).toBe('escalated')

    state = reduceEvent(state, event(4, 'run.handover', { takenBy: 'operator' }))
    expect(state.status).toBe('handling_human')
    expect(state.messages.at(-1)?.role).toBe('system')
    expect(state.messages.at(-1)?.text).toContain('人工坐席已接入')

    state = reduceEvent(
      state,
      event(5, 'operator.message', { text: '您好 请讲', sentBy: 'operator' }),
    )
    expect(state.messages.at(-1)).toEqual({ role: 'operator', text: '您好 请讲' })

    state = reduceEvent(state, event(6, 'message.user', { text: '我要退货' }))
    expect(state.messages.at(-1)?.role).toBe('user')

    state = reduceEvent(
      state,
      event(7, 'run.resolved', { summary: '坐席已解决 会话完结', resolvedBy: 'operator' }),
    )
    expect(state.status).toBe('completed')
    expect(state.messages.at(-1)?.text).toContain('坐席已标记解决')
  })

  it('SSE 断线重连重放人工接管事件 双向消息不丢失', () => {
    const replayed = [
      event(1, 'message.user', { text: '转人工' }),
      event(2, 'run.escalated', { reason: '客户要求人工' }),
      event(3, 'run.handover', { takenBy: 'operator' }),
      event(4, 'operator.message', { text: '您好 我是人工坐席', sentBy: 'operator' }),
      event(5, 'message.user', { text: '键盘失灵要求退货' }),
      event(6, 'run.resolved', { summary: '走质保换新', resolvedBy: 'operator' }),
    ]
    const state = reduceEvents(initialViewState(), replayed)
    expect(state.status).toBe('completed')
    expect(state.messages.filter((message) => message.role === 'operator')).toHaveLength(1)
    expect(state.messages.filter((message) => message.role === 'user')).toHaveLength(2)
  })

  it('金额展示分转元 千分位分隔', () => {
    expect(formatAmount(699900)).toBe('¥6,999.00')
    expect(formatAmount(8900)).toBe('¥89.00')
    expect(formatAmount(123456789)).toBe('¥1,234,567.89')
  })
})
