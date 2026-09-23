/**
 * 价保服务不变量测试
 *
 * 覆盖 政策分支 PP1-PP5 与 R6 大额路由 部分价保按 SKU 明细计算
 * 以及 归属校验 重复发起 审批令牌闸门 幂等退还 网关失败重试
 * 这些不变量是评测层断言可信的前提
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { PriceProtectionService } from '../src/services/price-protection-service.js'
import { ApprovalService } from '../src/services/approval-service.js'
import { AuditService } from '../src/services/audit-service.js'
import { FrozenClock } from '../src/clock.js'
import { createInMemoryRepositories, makeTestOrder } from '../src/testing.js'
import type { PaymentGatewayPort } from '../src/repositories.js'
import type { Order, ReturnRequest } from '../src/entities.js'

const BASE_TIME = '2026-09-20T12:00:00.000Z'

function setup(gateway?: PaymentGatewayPort) {
  const repos = createInMemoryRepositories()
  const clock = new FrozenClock(BASE_TIME)
  const audit = new AuditService(repos.auditRepo, clock)
  const approvals = new ApprovalService(repos.approvalRepo, clock)
  const service = new PriceProtectionService(
    repos.orderRepo,
    repos.returnRepo,
    repos.protectionRepo,
    repos.skuPriceRepo,
    repos.idempotencyRepo,
    gateway ?? repos.gateway,
    repos.noGenerator,
    approvals,
    audit,
    clock,
  )
  return { repos, clock, service, approvals }
}

/** 双商品订单 签收 2026-09-17 在价保窗口内 */
function seedOrder(order: Partial<Order> = {}): Order {
  return makeTestOrder({
    orderNo: 'SO-2026-0011',
    customerId: 'C1001',
    status: 'delivered',
    deliveredAt: '2026-09-17T12:00:00.000Z',
    totalAmountCents: 68_700,
    items: [
      {
        itemId: 'item-sp-1',
        sku: 'SKU-SP-001',
        title: '智能音箱',
        category: 'electronics',
        quantity: 2,
        unitPriceCents: 29_900,
      },
      {
        itemId: 'item-ca-1',
        sku: 'SKU-CA-001',
        title: '数据线',
        category: 'electronics',
        quantity: 1,
        unitPriceCents: 8_900,
      },
    ],
    ...order,
  })
}

/** 播种当前售价 SKU-SP-001 降 4000 分 SKU-CA-001 不降价 */
function seedPriceDrop(ctx: ReturnType<typeof setup>) {
  ctx.repos.skuPriceRepo.prices.set('SKU-SP-001', {
    sku: 'SKU-SP-001',
    currentUnitPriceCents: 25_900,
    updatedAt: '2026-09-19T00:00:00.000Z',
  })
}

function seedActiveReturn(ctx: ReturnType<typeof setup>) {
  const record: ReturnRequest = {
    returnNo: 'RT-2026-0001',
    orderNo: 'SO-2026-0011',
    customerId: 'C1001',
    type: 'return',
    reason: 'quality',
    status: 'submitted',
    itemIds: ['item-ca-1'],
    refundAmountCents: 8_900,
    currency: 'CNY',
    policyDecision: {
      outcome: 'allow',
      ruleId: 'R3_quality_window',
      explanation: '',
      feeBearer: 'seller',
    },
    policyVersion: '2026.09-v3',
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    version: 1,
  }
  ctx.repos.returnRepo.returns.set(record.returnNo, record)
}

/** 大额降价订单 单价 3800 元降至 1000 元 差价 2800×2=5600 元 触发 R6 */
function seedLargeDropOrder(): Order {
  return makeTestOrder({
    orderNo: 'SO-2026-0012',
    customerId: 'C1001',
    status: 'delivered',
    deliveredAt: '2026-09-17T12:00:00.000Z',
    totalAmountCents: 760_000,
    items: [
      {
        itemId: 'item-wa-1',
        sku: 'SKU-WA-001',
        title: '智能手表',
        category: 'electronics',
        quantity: 2,
        unitPriceCents: 380_000,
      },
    ],
  })
}

const customer = { role: 'customer' as const, customerId: 'C1001' }
const operator = { role: 'operator' as const }
const supervisor = { role: 'supervisor' as const }

describe('价保政策分支', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup()
    ctx.repos.orderRepo.orders.set('SO-2026-0011', seedOrder())
    seedPriceDrop(ctx)
  })

  it('PP1 未签收订单拒赔', async () => {
    ctx.repos.orderRepo.orders.set(
      'SO-2026-0011',
      seedOrder({ deliveredAt: null, status: 'paid' }),
    )
    const result = await ctx.service.createPriceProtection(customer, {
      orderNo: 'SO-2026-0011',
    })
    expect(result.status).toBe('rejected')
    expect(result.policyOutcome).toBe('deny')
    expect(result.refundAmountCents).toBe(0)
    expect(result.items).toHaveLength(0)
    expect(result.policyExplanation).toContain('尚未签收')
    const record = await ctx.repos.protectionRepo.findByProtectionNo(result.protectionNo)
    expect(record?.policyRuleId).toBe('PP1_not_delivered')
  })

  it('PP2 超过 7 天价保窗口拒赔', async () => {
    ctx.repos.orderRepo.orders.set(
      'SO-2026-0011',
      seedOrder({ deliveredAt: '2026-09-01T12:00:00.000Z' }),
    )
    const result = await ctx.service.createPriceProtection(customer, {
      orderNo: 'SO-2026-0011',
    })
    expect(result.policyOutcome).toBe('deny')
    expect(result.policyExplanation).toContain('超出价保窗口')
    const record = await ctx.repos.protectionRepo.findByProtectionNo(result.protectionNo)
    expect(record?.policyRuleId).toBe('PP2_window_expired')
  })

  it('PP3 退货进行中的订单拒赔', async () => {
    seedActiveReturn(ctx)
    const result = await ctx.service.createPriceProtection(customer, {
      orderNo: 'SO-2026-0011',
    })
    expect(result.policyOutcome).toBe('deny')
    expect(result.policyExplanation).toContain('进行中的售后')
    const record = await ctx.repos.protectionRepo.findByProtectionNo(result.protectionNo)
    expect(record?.policyRuleId).toBe('PP3_active_return')
  })

  it('PP4 无降价商品拒赔', async () => {
    ctx.repos.skuPriceRepo.prices.clear()
    const result = await ctx.service.createPriceProtection(customer, {
      orderNo: 'SO-2026-0011',
    })
    expect(result.policyOutcome).toBe('deny')
    expect(result.policyExplanation).toContain('未低于成交价')
    const record = await ctx.repos.protectionRepo.findByProtectionNo(result.protectionNo)
    expect(record?.policyRuleId).toBe('PP4_no_price_drop')
  })

  it('PP5 整单命中降价 差价按单价差乘数量计算', async () => {
    const result = await ctx.service.createPriceProtection(customer, {
      orderNo: 'SO-2026-0011',
    })
    expect(result.status).toBe('auto_approved')
    expect(result.policyOutcome).toBe('allow')
    expect(result.requiresApproval).toBe(false)
    expect(result.refundAmountCents).toBe(8_000)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      sku: 'SKU-SP-001',
      purchasePriceCents: 29_900,
      currentPriceCents: 25_900,
      quantity: 2,
      refundCents: 8_000,
    })
    expect(result.policyExplanation).toContain('合计差价 80.00元')
    expect(result.protectionNo).toBe('PP-2026-0001')
  })

  it('部分价保只计算指定商品的差价', async () => {
    const partial = await ctx.service.createPriceProtection(customer, {
      orderNo: 'SO-2026-0011',
      itemIds: ['item-sp-1'],
    })
    expect(partial.policyOutcome).toBe('allow')
    expect(partial.refundAmountCents).toBe(8_000)
  })

  it('指定商品未降价时按 PP4 拒赔', async () => {
    const noDrop = await ctx.service.createPriceProtection(customer, {
      orderNo: 'SO-2026-0011',
      itemIds: ['item-ca-1'],
    })
    expect(noDrop.policyOutcome).toBe('deny')
    expect(noDrop.refundAmountCents).toBe(0)
    const record = await ctx.repos.protectionRepo.findByProtectionNo(noDrop.protectionNo)
    expect(record?.policyRuleId).toBe('PP4_no_price_drop')
  })

  it('R6 差价达到大额阈值转人工审批', async () => {
    ctx.repos.orderRepo.orders.set('SO-2026-0012', seedLargeDropOrder())
    ctx.repos.skuPriceRepo.prices.set('SKU-WA-001', {
      sku: 'SKU-WA-001',
      currentUnitPriceCents: 100_000,
      updatedAt: '2026-09-19T00:00:00.000Z',
    })
    const result = await ctx.service.createPriceProtection(customer, {
      orderNo: 'SO-2026-0012',
    })
    expect(result.status).toBe('awaiting_approval')
    expect(result.policyOutcome).toBe('needs_approval')
    expect(result.requiresApproval).toBe(true)
    expect(result.refundAmountCents).toBe(560_000)
    expect(result.policyExplanation).toContain('大额阈值')
    const record = await ctx.repos.protectionRepo.findByProtectionNo(result.protectionNo)
    expect(record?.policyRuleId).toBe('R6_large_amount')
  })
})

describe('创建价保单不变量', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup()
    ctx.repos.orderRepo.orders.set('SO-2026-0011', seedOrder())
    seedPriceDrop(ctx)
  })

  it('订单不存在时拒绝', async () => {
    await expect(
      ctx.service.createPriceProtection(customer, { orderNo: 'SO-2026-9999' }),
    ).rejects.toThrow('订单不存在')
  })

  it('越权访问他人订单被拒绝并留审计', async () => {
    const attacker = { role: 'customer' as const, customerId: 'C9999' }
    await expect(
      ctx.service.createPriceProtection(attacker, { orderNo: 'SO-2026-0011' }),
    ).rejects.toThrow('无权访问该订单')
    expect(
      ctx.repos.auditRepo.entries.filter((e) => e.action === 'order_access_denied'),
    ).toHaveLength(1)
  })

  it('指定商品不属于订单时拒绝', async () => {
    await expect(
      ctx.service.createPriceProtection(customer, {
        orderNo: 'SO-2026-0011',
        itemIds: ['item-other'],
      }),
    ).rejects.toThrow('不属于订单')
  })

  it('同一订单不可重复申请价保', async () => {
    await ctx.service.createPriceProtection(customer, { orderNo: 'SO-2026-0011' })
    await expect(
      ctx.service.createPriceProtection(customer, { orderNo: 'SO-2026-0011' }),
    ).rejects.toThrow('不能重复申请')
  })

  it('拒赔不占位 降价后允许重新申请', async () => {
    ctx.repos.skuPriceRepo.prices.clear()
    const denied = await ctx.service.createPriceProtection(customer, {
      orderNo: 'SO-2026-0011',
    })
    expect(denied.status).toBe('rejected')

    seedPriceDrop(ctx)
    const retried = await ctx.service.createPriceProtection(customer, {
      orderNo: 'SO-2026-0011',
    })
    expect(retried.status).toBe('auto_approved')
    expect(
      ctx.repos.auditRepo.entries.filter((e) => e.action === 'price_protection_denied'),
    ).toHaveLength(1)
  })
})

describe('审批决定落地', () => {
  let ctx: ReturnType<typeof setup>
  let protectionNo: string
  beforeEach(async () => {
    ctx = setup()
    ctx.repos.orderRepo.orders.set('SO-2026-0012', seedLargeDropOrder())
    ctx.repos.skuPriceRepo.prices.set('SKU-WA-001', {
      sku: 'SKU-WA-001',
      currentUnitPriceCents: 100_000,
      updatedAt: '2026-09-19T00:00:00.000Z',
    })
    const created = await ctx.service.createPriceProtection(customer, {
      orderNo: 'SO-2026-0012',
    })
    protectionNo = created.protectionNo
  })

  it('通过后价保单进入待执行', async () => {
    const record = await ctx.service.applyApprovalDecision(supervisor, protectionNo, 'approved')
    expect(record.status).toBe('approved')
  })

  it('拒绝后价保单终结', async () => {
    const record = await ctx.service.applyApprovalDecision(supervisor, protectionNo, 'rejected')
    expect(record.status).toBe('rejected')
  })

  it('过期后价保单终结', async () => {
    const record = await ctx.service.applyApprovalDecision(supervisor, protectionNo, 'expired')
    expect(record.status).toBe('expired')
  })

  it('决定幂等 重复落地不改变状态', async () => {
    await ctx.service.applyApprovalDecision(supervisor, protectionNo, 'approved')
    const again = await ctx.service.applyApprovalDecision(supervisor, protectionNo, 'rejected')
    expect(again.status).toBe('approved')
  })
})

describe('执行退还', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup()
    ctx.repos.orderRepo.orders.set('SO-2026-0011', seedOrder())
    seedPriceDrop(ctx)
  })

  it('小额差价直接退还并扣网关一次', async () => {
    const created = await ctx.service.createPriceProtection(customer, {
      orderNo: 'SO-2026-0011',
    })
    const result = await ctx.service.executePriceProtection(operator, {
      protectionNo: created.protectionNo,
    })
    expect(result.status).toBe('succeeded')
    expect(result.replayed).toBe(false)
    expect(result.idempotencyKey).toBe(`price_protection:${created.protectionNo}`)
    expect(ctx.repos.gateway.totalSuccessfulCharges()).toBe(1)
    expect(
      ctx.repos.auditRepo.entries.filter((e) => e.action === 'price_protection_executed'),
    ).toHaveLength(1)
  })

  it('大额差价无令牌被拒绝 网关零扣款', async () => {
    ctx.repos.orderRepo.orders.set('SO-2026-0012', seedLargeDropOrder())
    ctx.repos.skuPriceRepo.prices.set('SKU-WA-001', {
      sku: 'SKU-WA-001',
      currentUnitPriceCents: 100_000,
      updatedAt: '2026-09-19T00:00:00.000Z',
    })
    const created = await ctx.service.createPriceProtection(customer, {
      orderNo: 'SO-2026-0012',
    })
    await ctx.service.applyApprovalDecision(supervisor, created.protectionNo, 'approved')
    await expect(
      ctx.service.executePriceProtection(operator, { protectionNo: created.protectionNo }),
    ).rejects.toThrow('不存在审批记录')
    expect(ctx.repos.gateway.totalSuccessfulCharges()).toBe(0)
  })

  it('大额差价持有效令牌退还成功', async () => {
    ctx.repos.orderRepo.orders.set('SO-2026-0012', seedLargeDropOrder())
    ctx.repos.skuPriceRepo.prices.set('SKU-WA-001', {
      sku: 'SKU-WA-001',
      currentUnitPriceCents: 100_000,
      updatedAt: '2026-09-19T00:00:00.000Z',
    })
    const created = await ctx.service.createPriceProtection(customer, {
      orderNo: 'SO-2026-0012',
    })
    const approval = await ctx.approvals.create({
      runId: 'run_1',
      resourceType: 'price_protection',
      resourceId: created.protectionNo,
      reason: '大额差价退还审批',
      amountCents: 560_000,
      requestedBy: 'C1001',
    })
    await ctx.approvals.decide(supervisor, approval.approvalId, 'approved')
    await ctx.service.applyApprovalDecision(supervisor, created.protectionNo, 'approved')
    const result = await ctx.service.executePriceProtection(operator, {
      protectionNo: created.protectionNo,
      approvalToken: approval.oneTimeToken,
    })
    expect(result.status).toBe('succeeded')
    expect(ctx.repos.gateway.totalSuccessfulCharges()).toBe(1)
  })

  it('同一价保单重复执行短路返回不二次扣款', async () => {
    const created = await ctx.service.createPriceProtection(customer, {
      orderNo: 'SO-2026-0011',
    })
    await ctx.service.executePriceProtection(operator, { protectionNo: created.protectionNo })
    const replay = await ctx.service.executePriceProtection(operator, {
      protectionNo: created.protectionNo,
    })
    expect(replay.replayed).toBe(true)
    expect(ctx.repos.gateway.totalSuccessfulCharges()).toBe(1)
  })

  it('网关失败回到可重试态 重试走同一幂等键成功', async () => {
    let failFirst = true
    const flakyGateway: PaymentGatewayPort = {
      chargeCount: () => 0,
      totalSuccessfulCharges: () => 0,
      async withRefund(idempotencyKey, request) {
        if (failFirst) {
          failFirst = false
          throw new Error('gateway down')
        }
        return { gatewayRefundId: `gw_${request.refundNo}`, deduped: false }
      },
    }
    const flaky = setup(flakyGateway)
    flaky.repos.orderRepo.orders.set('SO-2026-0011', seedOrder())
    seedPriceDrop(flaky)
    const created = await flaky.service.createPriceProtection(customer, {
      orderNo: 'SO-2026-0011',
    })
    await expect(
      flaky.service.executePriceProtection(operator, { protectionNo: created.protectionNo }),
    ).rejects.toThrow('价保退还失败')
    const record = await flaky.repos.protectionRepo.findByProtectionNo(created.protectionNo)
    expect(record?.status).toBe('failed')

    const retry = await flaky.service.executePriceProtection(operator, {
      protectionNo: created.protectionNo,
    })
    expect(retry.status).toBe('succeeded')
  })

  it('待审批状态不可直接执行', async () => {
    ctx.repos.orderRepo.orders.set('SO-2026-0012', seedLargeDropOrder())
    ctx.repos.skuPriceRepo.prices.set('SKU-WA-001', {
      sku: 'SKU-WA-001',
      currentUnitPriceCents: 100_000,
      updatedAt: '2026-09-19T00:00:00.000Z',
    })
    const created = await ctx.service.createPriceProtection(customer, {
      orderNo: 'SO-2026-0012',
    })
    await expect(
      ctx.service.executePriceProtection(operator, { protectionNo: created.protectionNo }),
    ).rejects.toThrow('不可执行退还')
  })
})
