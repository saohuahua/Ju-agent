import { describe, expect, it } from 'vitest'
import {
  canSendCustomerMessage,
  customerError,
  customerStatus,
  TERMINAL_STATUSES,
} from '../src/components/customer/customer-view'

describe('客户会话状态', () => {
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
