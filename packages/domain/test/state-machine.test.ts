/**
 * 状态机与脱敏测试
 */

import { describe, expect, it } from 'vitest'
import {
  assertReturnTransition,
  assertRunTransition,
  IllegalTransitionError,
} from '../src/state-machines.js'
import { maskPhone, maskEmail, maskCardNumber, redactText } from '../src/redact.js'

describe('状态机', () => {
  it('合法迁移通过', () => {
    expect(() => assertRunTransition('running', 'awaiting_input')).not.toThrow()
    expect(() => assertReturnTransition('auto_approved', 'awaiting_buyer_shipment')).not.toThrow()
  })

  it('非法迁移抛出结构化错误', () => {
    expect(() => assertRunTransition('completed', 'running')).toThrow(IllegalTransitionError)
    expect(() => assertReturnTransition('buyer_shipped', 'awaiting_buyer_shipment')).toThrow(
      IllegalTransitionError,
    )
  })

  it('终态拒绝任何迁移', () => {
    expect(() => assertReturnTransition('rejected', 'approved')).toThrow()
    expect(() => assertRunTransition('cancelled', 'running')).toThrow()
  })
})

describe('PII 脱敏', () => {
  it('手机号保留前 3 后 4', () => {
    expect(maskPhone('手机号 13812345678 已登记')).toBe('手机号 138****5678 已登记')
  })

  it('邮箱保留首字符与域名', () => {
    expect(maskEmail('联系 zhang.san@example.com')).toBe('联系 z****@example.com')
  })

  it('16 位以上连续数字按卡号遮蔽', () => {
    expect(maskCardNumber('卡号 6222020200112233445')).toBe('卡号 ****')
  })

  it('组合脱敏覆盖全部模式', () => {
    const raw = '13812345678 zhang@example.com 6222020200112233445'
    expect(redactText(raw)).toBe('138****5678 z****@example.com ****')
  })
})
