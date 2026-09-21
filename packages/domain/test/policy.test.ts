/**
 * 政策引擎表驱动测试
 *
 * 政策判定是整个系统可信度的基石 用边界值逐条覆盖
 */

import { describe, expect, it } from 'vitest'
import { decidePolicy, evaluateCompensationPolicy } from '../src/policy.js'
import { FrozenClock } from '../src/clock.js'
import { makeTestOrder } from '../src/testing.js'
import type { Shipment } from '../src/entities.js'

/** 冻结在 2026-09-20 12:00 UTC 的评测基准时刻 */
const BASE_TIME = '2026-09-20T12:00:00.000Z'
const clock = new FrozenClock(BASE_TIME)

function makeShipment(overrides: Partial<Shipment> = {}): Shipment {
  return {
    shipmentId: 'SH-0001',
    orderNo: 'SO-2026-0001',
    carrier: '顺丰速运',
    trackingNo: 'SF1234567890',
    status: 'delivered',
    events: [],
    deliveredAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  }
}

describe('R1 未发货取消', () => {
  it('已支付未发货允许全额仅退款', () => {
    const order = makeTestOrder({ status: 'paid', shippedAt: null, deliveredAt: null })
    const decision = decidePolicy({
      type: 'refund_only',
      reason: 'unshipped_cancel',
      order,
      shipment: null,
      itemIds: null,
      clock,
    })
    expect(decision.outcome).toBe('allow')
    expect(decision.ruleId).toBe('R1_unshipped_cancel')
    expect(decision.refundAmountCents).toBe(order.totalAmountCents)
  })

  it('已发货订单拒绝未发货仅退款', () => {
    const order = makeTestOrder({ status: 'shipped' })
    const decision = decidePolicy({
      type: 'refund_only',
      reason: 'unshipped_cancel',
      order,
      shipment: makeShipment(),
      itemIds: null,
      clock,
    })
    expect(decision.outcome).toBe('deny')
  })
})

describe('R2 物流丢件', () => {
  it('丢件允许全额仅退款', () => {
    const order = makeTestOrder({ status: 'shipped', deliveredAt: null })
    const shipment = makeShipment({ status: 'lost' })
    const decision = decidePolicy({
      type: 'refund_only',
      reason: 'lost_package',
      order,
      shipment,
      itemIds: null,
      clock,
    })
    expect(decision.outcome).toBe('allow')
    expect(decision.ruleId).toBe('R2_lost_package')
  })

  it('物流正常在途时按丢件申请被拒绝', () => {
    const order = makeTestOrder({ status: 'shipped' })
    const shipment = makeShipment({ status: 'in_transit' })
    const decision = decidePolicy({
      type: 'refund_only',
      reason: 'lost_package',
      order,
      shipment,
      itemIds: null,
      clock,
    })
    expect(decision.outcome).toBe('deny')
  })
})

describe('R3 质量问题窗口', () => {
  it('签收 15 天内允许退货退款', () => {
    const order = makeTestOrder({ deliveredAt: '2026-09-05T12:00:00.000Z' })
    const decision = decidePolicy({
      type: 'return',
      reason: 'quality',
      order,
      shipment: makeShipment(),
      itemIds: null,
      clock,
    })
    expect(decision.outcome).toBe('allow')
    expect(decision.feeBearer).toBe('seller')
  })

  it('签收超过 15 天拒绝', () => {
    const order = makeTestOrder({ deliveredAt: '2026-09-04T11:59:00.000Z' })
    const decision = decidePolicy({
      type: 'return',
      reason: 'quality',
      order,
      shipment: makeShipment(),
      itemIds: null,
      clock,
    })
    expect(decision.outcome).toBe('deny')
    expect(decision.ruleId).toBe('R3_quality_window')
  })

  it('质量问题仅退款需人工确认', () => {
    const order = makeTestOrder({ deliveredAt: '2026-09-15T00:00:00.000Z' })
    const decision = decidePolicy({
      type: 'refund_only',
      reason: 'damaged',
      order,
      shipment: makeShipment(),
      itemIds: null,
      clock,
    })
    expect(decision.outcome).toBe('needs_approval')
  })
})

describe('R4 七天无理由', () => {
  it('签收 7 天内允许无理由退货 买家承担运费', () => {
    const order = makeTestOrder({ deliveredAt: '2026-09-15T12:00:00.000Z' })
    const decision = decidePolicy({
      type: 'return',
      reason: 'no_reason',
      order,
      shipment: makeShipment(),
      itemIds: null,
      clock,
    })
    expect(decision.outcome).toBe('allow')
    expect(decision.feeBearer).toBe('buyer')
  })

  it('签收超过 7 天拒绝', () => {
    const order = makeTestOrder({ deliveredAt: '2026-09-12T12:00:01.000Z' })
    const decision = decidePolicy({
      type: 'return',
      reason: 'no_reason',
      order,
      shipment: makeShipment(),
      itemIds: null,
      clock,
    })
    expect(decision.outcome).toBe('deny')
  })

  it('生鲜类目不支持无理由退货', () => {
    const order = makeTestOrder({
      deliveredAt: '2026-09-18T00:00:00.000Z',
      items: [
        {
          itemId: 'item-fresh',
          sku: 'SKU-FRESH',
          title: '进口车厘子 2kg',
          category: 'fresh_food',
          quantity: 1,
          unitPriceCents: 15_900,
        },
      ],
    })
    const decision = decidePolicy({
      type: 'return',
      reason: 'no_reason',
      order,
      shipment: makeShipment(),
      itemIds: null,
      clock,
    })
    expect(decision.outcome).toBe('deny')
    expect(decision.explanation).toContain('不支持七天无理由')
  })
})

describe('R6 大额阈值', () => {
  it('大额退款在允许之上叠加人工审批', () => {
    const order = makeTestOrder({
      totalAmountCents: 699_900,
      status: 'paid',
      shippedAt: null,
      deliveredAt: null,
    })
    const decision = decidePolicy({
      type: 'refund_only',
      reason: 'unshipped_cancel',
      order,
      shipment: null,
      itemIds: null,
      clock,
    })
    expect(decision.outcome).toBe('needs_approval')
    expect(decision.ruleId).toBe('R6_large_amount')
  })
})

describe('部分退货金额计算', () => {
  it('按选中商品小计退款', () => {
    const order = makeTestOrder({
      items: [
        {
          itemId: 'item-1',
          sku: 'S1',
          title: '耳机',
          category: 'electronics',
          quantity: 1,
          unitPriceCents: 29_900,
        },
        {
          itemId: 'item-2',
          sku: 'S2',
          title: '手机壳',
          category: 'electronics',
          quantity: 2,
          unitPriceCents: 3_900,
        },
      ],
    })
    const decision = decidePolicy({
      type: 'return',
      reason: 'no_reason',
      order,
      shipment: makeShipment(),
      itemIds: ['item-2'],
      clock,
    })
    expect(decision.refundAmountCents).toBe(7_800)
  })
})

describe('补偿分级阈值', () => {
  it('不超过 50 元自动发放', () => {
    expect(evaluateCompensationPolicy({ amountCents: 3_000 })).toEqual({
      outcome: 'allow',
      ruleId: 'C1_auto_small',
      explanation: expect.stringContaining('自动发放'),
    })
  })

  it('恰好 50 元 5000 分落在自动发放侧', () => {
    const decision = evaluateCompensationPolicy({ amountCents: 5_000 })
    expect(decision.outcome).toBe('allow')
    expect(decision.ruleId).toBe('C1_auto_small')
  })

  it('超过 50 元转人工审批', () => {
    const decision = evaluateCompensationPolicy({ amountCents: 5_001 })
    expect(decision.outcome).toBe('needs_approval')
    expect(decision.ruleId).toBe('C2_large_approval')
  })

  it('补偿阈值与退款大额阈值相互独立', () => {
    // 退款大额阈值 5000 元 此处 60 元补偿就走审批
    // 反向 3000 元退款若走 R6 审批 与补偿 30 元自动发放互不影响
    expect(evaluateCompensationPolicy({ amountCents: 6_000 }).outcome).toBe('needs_approval')
    expect(evaluateCompensationPolicy({ amountCents: 3_000 }).outcome).toBe('allow')
  })
})

describe('兜底规则', () => {
  it('无理由仅退款没有匹配政策被拒绝', () => {
    const order = makeTestOrder({ deliveredAt: '2026-09-15T00:00:00.000Z' })
    const decision = decidePolicy({
      type: 'refund_only',
      reason: 'no_reason',
      order,
      shipment: makeShipment(),
      itemIds: null,
      clock,
    })
    expect(decision.outcome).toBe('deny')
    expect(decision.ruleId).toBe('R5_no_match')
  })
})
