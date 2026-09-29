import { expect, it } from 'vitest'
import { initialViewState, reduceEvent, reduceEvents } from '../src/lib/runReducer'
import type { AgentEvent } from '../src/lib/types'

/** SSE 实时消费与刷新回放必须得到相同选单视图 */
it('刷新恢复候选与补问 重复事件不重复添加 切换会话不保留旧订单', () => {
  const event = (sequence: number, type: string, payload: Record<string, unknown>): AgentEvent => ({
    runId: 'run-selection',
    sequence,
    type,
    payload,
    createdAt: '2026-09-20T12:00:00Z',
  })
  const candidates = {
    orders: [
      {
        orderNo: 'SO-2026-0003',
        items: [{ itemId: 'item-0003-1', title: '机械键盘', quantity: 1 }],
        status: 'delivered',
        totalAmountCents: 89900,
        currency: 'CNY',
        createdAt: '2026-09-10T00:00:00Z',
      },
    ],
    offset: 0,
    nextOffset: null,
  }
  const events = [
    event(1, 'message.user', { text: '收到后无法开机 我想退货' }),
    event(4, 'order.candidates', candidates),
    event(7, 'run.paused', { reason: 'awaiting_input', missingSlot: 'orderNo' }),
  ]
  const live = events.reduce(reduceEvent, initialViewState())
  const replayed = reduceEvents(initialViewState(), [...events, ...events])
  expect(replayed).toEqual(live)
  expect(replayed.orderCandidates).toEqual(candidates)
  expect(replayed.orderSelectionSlot).toBe('orderNo')
  const resumed = reduceEvent(replayed, event(8, 'run.resumed', {}))
  expect(resumed.orderSelectionSlot).toBeNull()
  expect(resumed.status).toBe('running')
  expect(initialViewState().orderCandidates).toBeNull()
  const reason = reduceEvent(resumed, event(9, 'run.paused', { reason: 'awaiting_input' }))
  expect(reason.orderSelectionSlot).toBeNull()
})
