import { describe, expect, it } from 'vitest'
import {
  canSendCustomerMessage,
  customerError,
  customerMessageText,
  customerStatus,
  TERMINAL_STATUSES,
} from '../src/components/customer/customer-view'

describe('客户会话状态', () => {
  it('选单消息不展示内部商品行 ID 仍保留用户可核对的商品与订单', () => {
    const command = '选择订单 SO-2026-0001 商品 item-0001-1'
    const candidates = [
      {
        runId: 'r',
        sequence: 2,
        type: 'order.candidates',
        createdAt: '',
        payload: {
          orders: [
            {
              orderNo: 'SO-2026-0001',
              items: [{ itemId: 'item-0001-1', title: '降噪耳机', quantity: 1 }],
            },
          ],
        },
      },
    ]
    expect(customerMessageText(command, candidates)).toBe('已选择降噪耳机（订单 SO-2026-0001）')
    expect(customerMessageText(command, [])).toBe('已选择商品（订单 SO-2026-0001）')
    expect(customerMessageText('我要查询订单 SO-2026-0001', candidates)).toBe(
      '我要查询订单 SO-2026-0001',
    )
  })
  it('人工接管仍允许继续留言且仅终态开放结案评价', () => {
    expect(customerStatus('handling_human').next).toContain('继续留言')
    expect(TERMINAL_STATUSES).not.toContain('handling_human')
    expect(TERMINAL_STATUSES).toEqual(['completed', 'failed', 'cancelled'])
  })

  it('客户错误文案不透出服务端诊断', () => {
    expect(customerError(new Error('internal token and raw prompt'), '发送失败 请重试')).toBe(
      '发送失败 请重试',
    )
    expect(customerError(new DOMException('旧身份', 'AbortError'), '发送失败')).toBe('')
  })

  it('无模型时仅允许继续已有人工会话', () => {
    expect(canSendCustomerMessage(null, 'created', false)).toBe(false)
    expect(canSendCustomerMessage('run-1', 'awaiting_input', false)).toBe(false)
    expect(canSendCustomerMessage('run-1', 'handling_human', false)).toBe(true)
    expect(canSendCustomerMessage('run-1', 'awaiting_input', true)).toBe(true)
  })
})
