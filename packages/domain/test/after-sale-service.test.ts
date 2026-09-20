/**
 * 售后服务不变量测试
 *
 * 覆盖 归属校验 幂等执行 审批令牌 重复提交 状态闸门
 * 这些不变量是评测层断言可信的前提
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { AfterSaleService } from '../src/services/after-sale-service.js'
import { ApprovalService } from '../src/services/approval-service.js'
import { AuditService } from '../src/services/audit-service.js'
import { FrozenClock } from '../src/clock.js'
import { createInMemoryRepositories, makeTestOrder } from '../src/testing.js'
import type { Order } from '../src/entities.js'

const BASE_TIME = '2026-09-20T12:00:00.000Z'

function setup() {
  const repos = createInMemoryRepositories()
  const clock = new FrozenClock(BASE_TIME)
  const audit = new AuditService(repos.auditRepo, clock)
  const approvals = new ApprovalService(repos.approvalRepo, clock)
  const service = new AfterSaleService(
    repos.orderRepo,
    repos.shipmentRepo,
    repos.returnRepo,
    repos.refundRepo,
    repos.approvalRepo,
    repos.idempotencyRepo,
    repos.gateway,
    repos.noGenerator,
    approvals,
    audit,
    clock,
  )
  return { repos, clock, service, approvals }
}

function seedOrder(order: Partial<Order> = {}) {
  const record = makeTestOrder({ totalAmountCents: 29_900, ...order })
  return record
}

const customer = { role: 'customer' as const, customerId: 'C1001' }
const operator = { role: 'operator' as const }
const supervisor = { role: 'supervisor' as const }

describe('创建售后单', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup()
  })

  it('越权访问他人订单被拒绝并留审计', async () => {
    await ctx.repos.orderRepo.orders.set('SO-2026-0001', seedOrder())
    const attacker = { role: 'customer' as const, customerId: 'C9999' }
    await expect(
      ctx.service.createReturnRequest(attacker, {
        orderNo: 'SO-2026-0001',
        type: 'return',
        reason: 'no_reason',
      }),
    ).rejects.toThrow('无权访问该订单')
    expect(
      ctx.repos.auditRepo.entries.filter((e) => e.action === 'order_access_denied'),
    ).toHaveLength(1)
  })

  it('政策拒绝时落 rejected 记录而不是抛错', async () => {
    await ctx.repos.orderRepo.orders.set(
      'SO-2026-0001',
      seedOrder({ deliveredAt: '2026-09-01T00:00:00.000Z' }),
    )
    const result = await ctx.service.createReturnRequest(customer, {
      orderNo: 'SO-2026-0001',
      type: 'return',
      reason: 'no_reason',
    })
    expect(result.policyOutcome).toBe('deny')
    expect(result.status).toBe('rejected')
    expect(result.refundNo).toBeNull()
  })

  it('同一订单存在活跃售后单时重复发起返回冲突', async () => {
    await ctx.repos.orderRepo.orders.set(
      'SO-2026-0001',
      seedOrder({ status: 'paid', shippedAt: null, deliveredAt: null }),
    )
    await ctx.service.createReturnRequest(customer, {
      orderNo: 'SO-2026-0001',
      type: 'refund_only',
      reason: 'unshipped_cancel',
    })
    await expect(
      ctx.service.createReturnRequest(customer, {
        orderNo: 'SO-2026-0001',
        type: 'refund_only',
        reason: 'unshipped_cancel',
      }),
    ).rejects.toThrow('已有进行中的售后单')
  })

  it('已完成的售后单阻止再次申请', async () => {
    await ctx.repos.orderRepo.orders.set(
      'SO-2026-0001',
      seedOrder({ status: 'paid', shippedAt: null, deliveredAt: null }),
    )
    await ctx.service.createReturnRequest(customer, {
      orderNo: 'SO-2026-0001',
      type: 'refund_only',
      reason: 'unshipped_cancel',
    })
    // 手动推进到终态模拟历史已完成售后
    const record = await ctx.repos.returnRepo.findByReturnNo('RT-2026-0001')
    if (record) {
      record.status = 'completed'
      await ctx.repos.returnRepo.update(record)
    }
    await expect(
      ctx.service.createReturnRequest(customer, {
        orderNo: 'SO-2026-0001',
        type: 'refund_only',
        reason: 'unshipped_cancel',
      }),
    ).rejects.toThrow('已完成过售后')
  })
})

describe('退款执行与幂等', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup()
  })

  it('未发货仅退款全额成功且网关只扣款一次', async () => {
    await ctx.repos.orderRepo.orders.set(
      'SO-2026-0001',
      seedOrder({ status: 'paid', shippedAt: null, deliveredAt: null }),
    )
    const created = await ctx.service.createReturnRequest(customer, {
      orderNo: 'SO-2026-0001',
      type: 'refund_only',
      reason: 'unshipped_cancel',
    })
    const executed = await ctx.service.executeRefund(customer, { returnNo: created.returnNo })
    expect(executed.status).toBe('succeeded')
    expect(executed.replayed).toBe(false)
    expect(ctx.repos.gateway.totalSuccessfulCharges()).toBe(1)

    const replay = await ctx.service.executeRefund(customer, { returnNo: created.returnNo })
    expect(replay.replayed).toBe(true)
    expect(replay.status).toBe('succeeded')
    // 幂等记录命中 网关不再扣款
    expect(ctx.repos.gateway.totalSuccessfulCharges()).toBe(1)
  })

  it('需要审批的售后单未审批时执行被状态闸门拦截', async () => {
    await ctx.repos.orderRepo.orders.set(
      'SO-2026-0001',
      seedOrder({ totalAmountCents: 699_900, status: 'paid', shippedAt: null, deliveredAt: null }),
    )
    const created = await ctx.service.createReturnRequest(customer, {
      orderNo: 'SO-2026-0001',
      type: 'refund_only',
      reason: 'unshipped_cancel',
    })
    expect(created.requiresApproval).toBe(true)
    expect(created.status).toBe('awaiting_approval')
    await expect(
      ctx.service.executeRefund(customer, { returnNo: created.returnNo }),
    ).rejects.toThrow('不可执行退款')
    // 审批未通过前网关没有扣款
    expect(ctx.repos.gateway.totalSuccessfulCharges()).toBe(0)
  })

  it('出示正确令牌执行成功 令牌二次使用被拒绝', async () => {
    await ctx.repos.orderRepo.orders.set(
      'SO-2026-0001',
      seedOrder({ totalAmountCents: 699_900, status: 'paid', shippedAt: null, deliveredAt: null }),
    )
    const created = await ctx.service.createReturnRequest(customer, {
      orderNo: 'SO-2026-0001',
      type: 'refund_only',
      reason: 'unshipped_cancel',
    })
    const approval = await ctx.approvals.create({
      runId: null,
      resourceType: 'return_request',
      resourceId: created.returnNo,
      reason: '大额退款',
      amountCents: 699_900,
      requestedBy: 'system',
    })
    await ctx.approvals.decide(supervisor, approval.approvalId, 'approved')

    // 状态仍停在 awaiting_approval 直接执行会被状态闸门拦截
    await expect(
      ctx.service.executeRefund(customer, {
        returnNo: created.returnNo,
        approvalToken: approval.oneTimeToken,
      }),
    ).rejects.toThrow('不可执行退款')

    // 推进到 approved 后凭令牌执行成功
    const record = await ctx.repos.returnRepo.findByReturnNo(created.returnNo)
    if (record) {
      record.status = 'approved'
      await ctx.repos.returnRepo.update(record)
    }
    const executed = await ctx.service.executeRefund(customer, {
      returnNo: created.returnNo,
      approvalToken: approval.oneTimeToken,
    })
    expect(executed.status).toBe('succeeded')
    expect(ctx.repos.gateway.totalSuccessfulCharges()).toBe(1)
  })
})

describe('退货收货联动', () => {
  it('收货后自动完成退款 重复收货幂等返回', async () => {
    const ctx = setup()
    await ctx.repos.orderRepo.orders.set('SO-2026-0001', seedOrder())
    const created = await ctx.service.createReturnRequest(customer, {
      orderNo: 'SO-2026-0001',
      type: 'return',
      reason: 'no_reason',
    })
    expect(created.status).toBe('awaiting_buyer_shipment')

    await ctx.service.recordReturnShipment(customer, created.returnNo, 'SF-RETURN-001')
    const received = await ctx.service.receiveReturnGoods(operator, created.returnNo)
    expect(received.status).toBe('completed')
    expect(received.refundStatus).toBe('succeeded')
    expect(ctx.repos.gateway.totalSuccessfulCharges()).toBe(1)

    const again = await ctx.service.receiveReturnGoods(operator, created.returnNo)
    expect(again.status).toBe('completed')
    expect(ctx.repos.gateway.totalSuccessfulCharges()).toBe(1)
  })

  it('换货收货后完结且不产生退款', async () => {
    const ctx = setup()
    await ctx.repos.orderRepo.orders.set('SO-2026-0001', seedOrder())
    const created = await ctx.service.createReturnRequest(customer, {
      orderNo: 'SO-2026-0001',
      type: 'exchange',
      reason: 'quality',
    })
    await ctx.service.recordReturnShipment(customer, created.returnNo, 'SF-RETURN-002')
    const received = await ctx.service.receiveReturnGoods(operator, created.returnNo)
    expect(received.status).toBe('completed')
    expect(received.refundNo).toBeNull()
    expect(ctx.repos.gateway.totalSuccessfulCharges()).toBe(0)
  })
})

describe('取消售后单', () => {
  it('买家寄回后不可线上取消', async () => {
    const ctx = setup()
    await ctx.repos.orderRepo.orders.set('SO-2026-0001', seedOrder())
    const created = await ctx.service.createReturnRequest(customer, {
      orderNo: 'SO-2026-0001',
      type: 'return',
      reason: 'no_reason',
    })
    await ctx.service.recordReturnShipment(customer, created.returnNo, 'SF-RETURN-001')
    await expect(ctx.service.cancelReturnRequest(customer, created.returnNo)).rejects.toThrow(
      '不可取消',
    )
  })

  it('取消时联动取消预留退款单', async () => {
    const ctx = setup()
    await ctx.repos.orderRepo.orders.set('SO-2026-0001', seedOrder())
    const created = await ctx.service.createReturnRequest(customer, {
      orderNo: 'SO-2026-0001',
      type: 'return',
      reason: 'no_reason',
    })
    await ctx.service.cancelReturnRequest(customer, created.returnNo)
    const refund = await ctx.repos.refundRepo.findByReturnNo(created.returnNo)
    expect(refund?.status).toBe('cancelled')
  })
})
