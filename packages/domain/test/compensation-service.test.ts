/**
 * 补偿服务不变量测试
 *
 * 覆盖 金额校验 归属校验 分级落位 不可叠加 审批令牌闸门 幂等发放 网关失败重试
 * 这些不变量是评测层断言可信的前提
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { CompensationService } from '../src/services/compensation-service.js'
import { ApprovalService } from '../src/services/approval-service.js'
import { AuditService } from '../src/services/audit-service.js'
import { FrozenClock } from '../src/clock.js'
import { createInMemoryRepositories, makeTestOrder } from '../src/testing.js'
import type { PaymentGatewayPort } from '../src/repositories.js'
import type { Order } from '../src/entities.js'

const BASE_TIME = '2026-09-20T12:00:00.000Z'

function setup(gateway?: PaymentGatewayPort) {
  const repos = createInMemoryRepositories()
  const clock = new FrozenClock(BASE_TIME)
  const audit = new AuditService(repos.auditRepo, clock)
  const approvals = new ApprovalService(repos.approvalRepo, clock)
  const service = new CompensationService(
    repos.orderRepo,
    repos.compensationRepo,
    repos.idempotencyRepo,
    gateway ?? repos.gateway,
    repos.noGenerator,
    approvals,
    audit,
    clock,
  )
  return { repos, clock, service, approvals }
}

function seedOrder(order: Partial<Order> = {}) {
  return makeTestOrder({
    orderNo: 'SO-2026-0003',
    customerId: 'C1001',
    status: 'delivered',
    deliveredAt: '2026-09-15T12:00:00.000Z',
    totalAmountCents: 89_900,
    ...order,
  })
}

const customer = { role: 'customer' as const, customerId: 'C1001' }
const operator = { role: 'operator' as const }
const supervisor = { role: 'supervisor' as const }

describe('创建补偿单', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup()
    ctx.repos.orderRepo.orders.set('SO-2026-0003', seedOrder())
  })

  it('金额必须大于 0', async () => {
    await expect(
      ctx.service.createCompensation(customer, {
        orderNo: 'SO-2026-0003',
        reason: 'late_delivery',
        amountCents: 0,
      }),
    ).rejects.toThrow('补偿金额必须大于 0')
  })

  it('订单不存在时拒绝', async () => {
    await expect(
      ctx.service.createCompensation(customer, {
        orderNo: 'SO-2026-9999',
        reason: 'late_delivery',
        amountCents: 3_000,
      }),
    ).rejects.toThrow('订单不存在')
  })

  it('越权访问他人订单被拒绝并留审计', async () => {
    const attacker = { role: 'customer' as const, customerId: 'C9999' }
    await expect(
      ctx.service.createCompensation(attacker, {
        orderNo: 'SO-2026-0003',
        reason: 'late_delivery',
        amountCents: 3_000,
      }),
    ).rejects.toThrow('无权访问该订单')
    expect(
      ctx.repos.auditRepo.entries.filter((e) => e.action === 'order_access_denied'),
    ).toHaveLength(1)
  })

  it('小额补偿落自动发放 无需审批', async () => {
    const result = await ctx.service.createCompensation(customer, {
      orderNo: 'SO-2026-0003',
      reason: 'late_delivery',
      amountCents: 3_000,
    })
    expect(result.status).toBe('auto_approved')
    expect(result.requiresApproval).toBe(false)
    expect(result.compensationNo).toBe('CP-2026-0001')
    expect(result.policyExplanation).toContain('自动发放')
  })

  it('大额补偿落待审批', async () => {
    const result = await ctx.service.createCompensation(customer, {
      orderNo: 'SO-2026-0003',
      reason: 'late_delivery',
      amountCents: 6_000,
    })
    expect(result.status).toBe('awaiting_approval')
    expect(result.requiresApproval).toBe(true)
    expect(result.policyExplanation).toContain('人工审批')
  })

  it('同一订单同一原因不可重复发起', async () => {
    await ctx.service.createCompensation(customer, {
      orderNo: 'SO-2026-0003',
      reason: 'late_delivery',
      amountCents: 3_000,
    })
    await expect(
      ctx.service.createCompensation(customer, {
        orderNo: 'SO-2026-0003',
        reason: 'late_delivery',
        amountCents: 5_000,
      }),
    ).rejects.toThrow('不能重复发放')
  })

  it('被拒后允许换原因重新补偿', async () => {
    const first = await ctx.service.createCompensation(customer, {
      orderNo: 'SO-2026-0003',
      reason: 'late_delivery',
      amountCents: 6_000,
    })
    await ctx.service.applyApprovalDecision(supervisor, first.compensationNo, 'rejected')
    const second = await ctx.service.createCompensation(customer, {
      orderNo: 'SO-2026-0003',
      reason: 'service_apology',
      amountCents: 3_000,
    })
    expect(second.status).toBe('auto_approved')
  })
})

describe('审批决定落地', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup()
    ctx.repos.orderRepo.orders.set('SO-2026-0003', seedOrder())
  })

  it('通过后补偿单进入待执行', async () => {
    const created = await ctx.service.createCompensation(customer, {
      orderNo: 'SO-2026-0003',
      reason: 'late_delivery',
      amountCents: 6_000,
    })
    const record = await ctx.service.applyApprovalDecision(
      supervisor,
      created.compensationNo,
      'approved',
    )
    expect(record.status).toBe('approved')
  })

  it('拒绝后补偿单终结', async () => {
    const created = await ctx.service.createCompensation(customer, {
      orderNo: 'SO-2026-0003',
      reason: 'late_delivery',
      amountCents: 6_000,
    })
    const record = await ctx.service.applyApprovalDecision(
      supervisor,
      created.compensationNo,
      'rejected',
    )
    expect(record.status).toBe('rejected')
  })

  it('过期后补偿单终结', async () => {
    const created = await ctx.service.createCompensation(customer, {
      orderNo: 'SO-2026-0003',
      reason: 'late_delivery',
      amountCents: 6_000,
    })
    const record = await ctx.service.applyApprovalDecision(
      supervisor,
      created.compensationNo,
      'expired',
    )
    expect(record.status).toBe('expired')
  })

  it('决定幂等 重复落地不改变状态', async () => {
    const created = await ctx.service.createCompensation(customer, {
      orderNo: 'SO-2026-0003',
      reason: 'late_delivery',
      amountCents: 6_000,
    })
    await ctx.service.applyApprovalDecision(supervisor, created.compensationNo, 'approved')
    const again = await ctx.service.applyApprovalDecision(
      supervisor,
      created.compensationNo,
      'rejected',
    )
    expect(again.status).toBe('approved')
  })
})

describe('执行发放', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup()
    ctx.repos.orderRepo.orders.set('SO-2026-0003', seedOrder())
  })

  it('小额补偿直接发放并扣网关一次', async () => {
    const created = await ctx.service.createCompensation(customer, {
      orderNo: 'SO-2026-0003',
      reason: 'late_delivery',
      amountCents: 3_000,
    })
    const result = await ctx.service.executeCompensation(operator, {
      compensationNo: created.compensationNo,
    })
    expect(result.status).toBe('succeeded')
    expect(result.replayed).toBe(false)
    expect(ctx.repos.gateway.totalSuccessfulCharges()).toBe(1)
  })

  it('大额补偿无令牌被拒绝 网关零扣款', async () => {
    const created = await ctx.service.createCompensation(customer, {
      orderNo: 'SO-2026-0003',
      reason: 'late_delivery',
      amountCents: 6_000,
    })
    await ctx.service.applyApprovalDecision(supervisor, created.compensationNo, 'approved')
    await expect(
      ctx.service.executeCompensation(operator, { compensationNo: created.compensationNo }),
    ).rejects.toThrow('不存在审批记录')
    expect(ctx.repos.gateway.totalSuccessfulCharges()).toBe(0)
  })

  it('大额补偿持有效令牌发放成功', async () => {
    const created = await ctx.service.createCompensation(customer, {
      orderNo: 'SO-2026-0003',
      reason: 'late_delivery',
      amountCents: 6_000,
    })
    const approval = await ctx.approvals.create({
      runId: 'run_1',
      resourceType: 'compensation',
      resourceId: created.compensationNo,
      reason: '大额补偿审批',
      amountCents: 6_000,
      requestedBy: 'C1001',
    })
    await ctx.approvals.decide(supervisor, approval.approvalId, 'approved')
    await ctx.service.applyApprovalDecision(supervisor, created.compensationNo, 'approved')
    const result = await ctx.service.executeCompensation(operator, {
      compensationNo: created.compensationNo,
      approvalToken: approval.oneTimeToken,
    })
    expect(result.status).toBe('succeeded')
    expect(ctx.repos.gateway.totalSuccessfulCharges()).toBe(1)
  })

  it('同一补偿单重复执行短路返回不二次扣款', async () => {
    const created = await ctx.service.createCompensation(customer, {
      orderNo: 'SO-2026-0003',
      reason: 'late_delivery',
      amountCents: 3_000,
    })
    await ctx.service.executeCompensation(operator, { compensationNo: created.compensationNo })
    const replay = await ctx.service.executeCompensation(operator, {
      compensationNo: created.compensationNo,
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
        return { gatewayRefundId: `gw_${request.refundNo}` }
      },
    }
    const flaky = setup(flakyGateway)
    flaky.repos.orderRepo.orders.set('SO-2026-0003', seedOrder())
    const created = await flaky.service.createCompensation(customer, {
      orderNo: 'SO-2026-0003',
      reason: 'late_delivery',
      amountCents: 3_000,
    })
    await expect(
      flaky.service.executeCompensation(operator, { compensationNo: created.compensationNo }),
    ).rejects.toThrow('补偿发放失败')
    const record = await flaky.repos.compensationRepo.findByCompensationNo(created.compensationNo)
    expect(record?.status).toBe('failed')

    const retry = await flaky.service.executeCompensation(operator, {
      compensationNo: created.compensationNo,
    })
    expect(retry.status).toBe('succeeded')
  })

  it('待审批状态不可直接执行', async () => {
    const created = await ctx.service.createCompensation(customer, {
      orderNo: 'SO-2026-0003',
      reason: 'late_delivery',
      amountCents: 6_000,
    })
    await expect(
      ctx.service.executeCompensation(operator, { compensationNo: created.compensationNo }),
    ).rejects.toThrow('不可执行发放')
  })
})
