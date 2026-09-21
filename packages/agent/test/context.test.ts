/**
 * 上下文重建测试
 *
 * 覆盖物流推送合成的 user 消息与原生协议结构的兼容
 * 悬空的 tool_use 必须被合成 tool_result 配对 否则中转按结构校验拒绝
 */

import { describe, expect, it } from 'vitest'
import { rebuildMessages } from '../src/index.js'

interface EventRow {
  type: string
  payload: unknown
}

const ASK_ID = 'call_00_test'

function askUserTurn(text: string): EventRow {
  return {
    type: 'agent.turn',
    payload: {
      blocks: [
        { type: 'text', text },
        {
          type: 'tool_use',
          toolCallId: ASK_ID,
          toolName: 'ask_user',
          input: { question: '请问订单号是多少？', missingSlot: 'orderNo' },
        },
      ],
      stopReason: 'tool_use',
    },
  }
}

function logisticsEvent(eventId: string): EventRow {
  return {
    type: 'logistics.event',
    payload: {
      orderNo: 'SO-2026-0002',
      carrier: '顺丰速运',
      trackingNo: 'SF1357924680',
      status: 'delayed',
      description: '运输延误',
      eventId,
      source: 'operator',
      injectedAt: '2026-09-21T10:00:00.000Z',
    },
  }
}

describe('物流推送消息重建', () => {
  it('挂起的补问调用被合成 tool_result 配对 保证原生协议结构合法', () => {
    const events: EventRow[] = [
      { type: 'message.user', payload: { text: '我要退货' } },
      askUserTurn('请问您要退的是哪个订单？'),
      logisticsEvent('op_1'),
    ]
    const messages = rebuildMessages(events)

    // 末条 user 消息同时携带配对 tool_result 与物流推送文本
    const push = messages.at(-1)
    expect(push?.role).toBe('user')
    const blocks = push?.content ?? []
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({
      type: 'tool_result',
      toolCallId: ASK_ID,
      toolName: 'ask_user',
      isError: false,
    })
    expect(blocks[1]?.type).toBe('text')
    expect(String((blocks[1] as { text: string }).text)).toContain('[物流事件推送]')
    expect(String((blocks[1] as { text: string }).text)).toContain('运输延误')
  })

  it('多次推送只配对一次 后续推送为纯文本', () => {
    const events: EventRow[] = [
      askUserTurn('请问您要退的是哪个订单？'),
      logisticsEvent('op_1'),
      logisticsEvent('op_2'),
    ]
    const messages = rebuildMessages(events)

    const first = messages[1]
    const second = messages[2]
    expect(first?.role).toBe('user')
    expect((first?.content ?? []).some((block) => block.type === 'tool_result')).toBe(true)
    // 第二次推送不重复配对同一调用
    expect((second?.content ?? []).some((block) => block.type === 'tool_result')).toBe(false)
    expect((second?.content ?? []).every((block) => block.type === 'text')).toBe(true)
  })

  it('补问已被用户答复时不合成配对', () => {
    const events: EventRow[] = [
      askUserTurn('请问您要退的是哪个订单？'),
      { type: 'message.user', payload: { text: 'SO-2026-0002', replyToToolCallId: ASK_ID } },
      logisticsEvent('op_1'),
    ]
    const messages = rebuildMessages(events)

    const push = messages.at(-1)
    expect(push?.role).toBe('user')
    expect((push?.content ?? []).every((block) => block.type === 'text')).toBe(true)
  })

  it('无挂起调用时推送为纯文本消息', () => {
    const events: EventRow[] = [
      { type: 'message.user', payload: { text: '订单 SO-2026-0002 到哪了' } },
      logisticsEvent('op_1'),
    ]
    const messages = rebuildMessages(events)

    expect(messages).toHaveLength(2)
    const push = messages[1]
    expect(push?.role).toBe('user')
    expect((push?.content ?? []).every((block) => block.type === 'text')).toBe(true)
  })
})
