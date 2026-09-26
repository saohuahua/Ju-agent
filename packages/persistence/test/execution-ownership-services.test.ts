import { afterEach, expect, it, vi } from 'vitest'
import {
  AfterSaleService,
  CompensationService,
  PriceProtectionService,
  ApprovalService,
  AuditService,
  FrozenClock,
} from '@aftersales/domain'
import { createInMemoryRepositories, makeTestOrder } from '../../domain/src/testing.js'
import { createMemoryDatabase } from '../src/db.js'
import {
  SqliteReturnRepository,
  SqliteRefundRepository,
  SqliteCompensationRepository,
  SqlitePriceProtectionRepository,
} from '../src/business-repositories.js'
import { SqliteIdempotencyRepository } from '../src/infrastructure-repositories.js'
import { migrateExecutionOwnership } from '../src/execution-ownership-migration.js'
import { ExecutionOwnershipRepository } from '../src/execution-ownership-repository.js'
import {
  acceptExecutionOwnedCommand,
  executionOwnershipPreparePayment,
  executionOwnershipApplyPayment,
} from '../src/execution-ownership-p6.js'
import { p6ReadyPayment } from '../src/p6-business-adapter.js'
import { P6TaskRepository } from '../src/p6-task-repository.js'

const databases: ReturnType<typeof createMemoryDatabase>[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
const kinds = ['refund', 'compensation', 'price_protection'] as const
const actor = { role: 'customer' as const, customerId: 'C1001' }
const config = {
  snapshotId: 'test',
  provider: 'scripted',
  model: 'scripted',
  promptVersion: 'v1',
  value: {},
}

/** 业务服务和资金仓储使用真实实现 渠道只在本地模拟 */
async function setup(kind: (typeof kinds)[number], receive = false) {
  const db = createMemoryDatabase()
  databases.push(db)
  migrateExecutionOwnership(db)
  const ownership = new ExecutionOwnershipRepository(db)
  const repos = createInMemoryRepositories()
  const clock = new FrozenClock('2026-09-20T12:00:00.000Z')
  const audit = new AuditService(repos.auditRepo, clock)
  const approvals = new ApprovalService(repos.approvalRepo, clock)
  const idempotency = new SqliteIdempotencyRepository(db)
  const gateway = {
    ...repos.gateway,
    withRefund: vi.fn(repos.gateway.withRefund.bind(repos.gateway)),
    chargeCount: repos.gateway.chargeCount.bind(repos.gateway),
    totalSuccessfulCharges: repos.gateway.totalSuccessfulCharges.bind(repos.gateway),
  }
  repos.orderRepo.orders.set(
    'SO-2026-0001',
    makeTestOrder(
      kind === 'refund' && !receive ? { status: 'paid', shippedAt: null, deliveredAt: null } : {},
    ),
  )
  repos.skuPriceRepo.prices.set('SKU-001', {
    sku: 'SKU-001',
    currentUnitPriceCents: 9900,
    updatedAt: clock.now().toISOString(),
  })
  const returns = new SqliteReturnRepository(db)
  const refunds = new SqliteRefundRepository(db)
  const afterSale = new AfterSaleService(
    repos.orderRepo,
    repos.shipmentRepo,
    returns,
    refunds,
    repos.approvalRepo,
    idempotency,
    gateway,
    repos.noGenerator,
    approvals,
    audit,
    clock,
    ownership,
  )
  const compensation = new CompensationService(
    repos.orderRepo,
    new SqliteCompensationRepository(db),
    idempotency,
    gateway,
    repos.noGenerator,
    approvals,
    audit,
    clock,
    ownership,
  )
  const price = new PriceProtectionService(
    repos.orderRepo,
    returns,
    new SqlitePriceProtectionRepository(db),
    repos.skuPriceRepo,
    idempotency,
    gateway,
    repos.noGenerator,
    approvals,
    audit,
    clock,
    ownership,
  )
  let key: string
  let resourceId: string
  let execute: (runId?: string) => Promise<unknown>
  if (kind === 'refund') {
    const created = await afterSale.createReturnRequest(actor, {
      orderNo: 'SO-2026-0001',
      type: receive ? 'return' : 'refund_only',
      reason: receive ? 'no_reason' : 'unshipped_cancel',
    })
    key = `refund:${created.returnNo}`
    resourceId = created.refundNo!
    if (receive) await afterSale.recordReturnShipment(actor, created.returnNo, 'local')
    execute = (runId) =>
      receive
        ? afterSale.receiveReturnGoods({ role: 'operator' }, created.returnNo, runId)
        : afterSale.executeRefund(actor, { returnNo: created.returnNo }, runId)
  } else if (kind === 'compensation') {
    const created = await compensation.createCompensation(actor, {
      orderNo: 'SO-2026-0001',
      reason: 'late_delivery',
      amountCents: 100,
    })
    key = `compensation:${created.compensationNo}`
    resourceId = created.compensationNo
    execute = (runId) =>
      compensation.executeCompensation(actor, { compensationNo: resourceId }, runId)
  } else {
    const created = await price.createPriceProtection(actor, { orderNo: 'SO-2026-0001' })
    key = `price_protection:${created.protectionNo}`
    resourceId = created.protectionNo
    execute = (runId) => price.executePriceProtection(actor, { protectionNo: resourceId }, runId)
  }
  const input = () => ({
    customerId: 'C1001',
    requestKey: 'first',
    kind: 'start' as const,
    config,
    plan: { input: '', tool: kind, payment: p6ReadyPayment(db, kind, resourceId, 'C1001') },
  })
  return { db, ownership, key, execute, gateway, idempotency, input, refunds }
}

it.each(kinds)('P6 接管后真实旧 %s 服务不能触碰渠道', async (kind) => {
  const c = await setup(kind)
  const task = acceptExecutionOwnedCommand(c.db, c.input())
  await expect(c.execute('legacy-run')).rejects.toThrow('执行权')
  expect(c.gateway.withRefund).not.toHaveBeenCalled()
  expect(c.ownership.get(c.key)).toMatchObject({
    owner: 'p6',
    holder: task.commandId,
    state: 'ready',
  })
})

it('收货联动仍经过退款许可守卫', async () => {
  const c = await setup('refund', true)
  c.ownership.takeoverWithCommand(c.key, () => ({ commandId: 'waiting-receipt' }))
  await expect(c.execute()).rejects.toThrow('执行权')
  expect(c.gateway.withRefund).not.toHaveBeenCalled()
  expect(c.db.prepare('SELECT status FROM return_requests').get()).toEqual({
    status: 'goods_received',
  })
})

it('旧服务在许可提交后渠道调用前暂停时接管仍失败', async () => {
  const c = await setup('refund')
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const update = c.refunds.update.bind(c.refunds)
  vi.spyOn(c.refunds, 'update').mockImplementationOnce(async (refund) => {
    await update(refund)
    entered()
    await blocked
  })
  const execution = c.execute()
  await waiting
  expect(c.gateway.withRefund).not.toHaveBeenCalled()
  expect(c.ownership.get(c.key)?.state).toBe('sending')
  expect(() => c.ownership.takeoverWithCommand(c.key, () => ({ commandId: 'p6' }))).toThrow()
  release()
  await execution
  expect(c.gateway.withRefund).toHaveBeenCalledTimes(1)
})

it.each(kinds)('旧 %s 成功业务记录缺少幂等记录时只读重放', async (kind) => {
  const c = await setup(kind)
  await c.execute()
  c.db.prepare('DELETE FROM idempotency_records WHERE key = ?').run(c.key)
  await expect(c.execute('new-run')).resolves.toMatchObject({ replayed: true, status: 'succeeded' })
  expect(c.gateway.withRefund).toHaveBeenCalledTimes(1)
  expect(await c.idempotency.find(c.key)).toBeNull()
})

it.each(kinds)('旧 %s 已获许可并等待渠道时接管失败', async (kind) => {
  const c = await setup(kind)
  let release!: (result: { gatewayRefundId: string; deduped: boolean }) => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  c.gateway.withRefund.mockImplementationOnce(() => {
    entered()
    return new Promise((resolve) => {
      release = resolve
    })
  })
  const running = c.execute('old-run')
  await waiting
  expect(() => c.ownership.takeoverWithCommand(c.key, () => ({ commandId: 'new-run' }))).toThrow(
    '执行权',
  )
  release({ gatewayRefundId: 'local', deduped: false })
  await running
  expect(c.ownership.get(c.key)?.state).toBe('succeeded')
  expect(c.gateway.withRefund).toHaveBeenCalledTimes(1)
})

it.each(kinds)('旧 %s 结果未知时新运行和失败重试均不重发', async (kind) => {
  const c = await setup(kind)
  const input = c.input()
  const send = c.gateway.withRefund.getMockImplementation()!
  c.gateway.withRefund.mockImplementationOnce(async (key, request) => {
    await send(key, request)
    throw new Error('模拟支付成功但响应丢失')
  })
  await expect(c.execute('run-a')).rejects.toThrow()
  expect(c.ownership.get(c.key)?.state).toBe('unknown')
  await expect(c.execute('run-b')).rejects.toThrow('执行权')
  expect(() => acceptExecutionOwnedCommand(c.db, input)).toThrow('执行权')
  expect(c.gateway.withRefund).toHaveBeenCalledTimes(1)
  expect(c.gateway.chargeCount(c.key)).toBe(1)
})

it.each(kinds)('旧 %s 成功结果及幂等记录不被重放覆盖', async (kind) => {
  const c = await setup(kind)
  await c.execute('run-a')
  const prior = c.db.prepare('SELECT * FROM idempotency_records').all()
  const ownership = c.ownership.get(c.key)
  await expect(c.execute('run-b')).resolves.toMatchObject({ replayed: true, status: 'succeeded' })
  expect(c.db.prepare('SELECT * FROM idempotency_records').all()).toEqual(prior)
  expect(c.ownership.get(c.key)).toEqual(ownership)
  expect(c.gateway.withRefund).toHaveBeenCalledTimes(1)
})

it.each(kinds)('旧 %s 渠道成功后本地记账失败仍不能重发', async (kind) => {
  const c = await setup(kind)
  vi.spyOn(c.idempotency, 'record').mockRejectedValueOnce(new Error('模拟落库失败'))
  await expect(c.execute()).rejects.toThrow('模拟落库失败')
  expect(c.ownership.get(c.key)?.state).toBe('succeeded')
  await c.execute('another-run').catch(() => undefined)
  expect(c.gateway.withRefund).toHaveBeenCalledTimes(1)
  expect(() => c.ownership.takeoverWithCommand(c.key, () => ({ commandId: 'new' }))).toThrow()
})

it('接管与真实命令受理失败一起回滚 随后旧路径仍能执行', async () => {
  const c = await setup('compensation')
  c.db.exec(
    "CREATE TRIGGER execution_ownership_fail BEFORE INSERT ON p6_tasks BEGIN SELECT RAISE(ABORT,'受理失败'); END",
  )
  expect(() => acceptExecutionOwnedCommand(c.db, c.input())).toThrow('受理失败')
  expect(c.ownership.get(c.key)).toMatchObject({ owner: 'legacy', state: 'ready', holder: '' })
  expect(c.db.prepare('SELECT * FROM p6_commands').all()).toHaveLength(0)
  expect(c.db.prepare('SELECT * FROM agent_runs').all()).toHaveLength(0)
  await c.execute()
  expect(c.gateway.withRefund).toHaveBeenCalledTimes(1)
})

it('同一业务键的新命令不能换运行接管 原命令允许幂等读取', async () => {
  const c = await setup('compensation')
  const input = c.input()
  const first = acceptExecutionOwnedCommand(c.db, input)
  expect(acceptExecutionOwnedCommand(c.db, input).taskId).toBe(first.taskId)
  expect(() => acceptExecutionOwnedCommand(c.db, { ...input, requestKey: 'second' })).toThrow(
    '执行权',
  )
  expect(c.db.prepare('SELECT * FROM agent_runs').all()).toHaveLength(1)
})

it.each(kinds)('P6 %s 许可和资金意图及成功结果使用同库事务', async (kind) => {
  const c = await setup(kind)
  const input = c.input()
  acceptExecutionOwnedCommand(c.db, input)
  const tasks = new P6TaskRepository(c.db)
  const claim = tasks.claim('worker', 10000, { global: 2, customer: 2, provider: 2, tool: 2 })!
  const payment = input.plan.payment
  expect(() =>
    tasks.beginPayment(claim, payment, (db, p, task) => {
      executionOwnershipPreparePayment(db, p, task)
      throw new Error('准备回滚')
    }),
  ).toThrow('准备回滚')
  expect(c.ownership.get(c.key)?.state).toBe('ready')
  expect(tasks.effect(payment)).toBeUndefined()
  expect(tasks.beginPayment(claim, payment, executionOwnershipPreparePayment)).toBe(true)
  tasks.settle(
    claim,
    payment,
    { status: 'unknown', reason: '模拟未知' },
    executionOwnershipApplyPayment,
  )
  expect(c.ownership.get(c.key)?.state).toBe('sending')
  expect(tasks.beginPayment(claim, payment, executionOwnershipPreparePayment)).toBe(false)
  expect(() =>
    tasks.settle(
      claim,
      payment,
      { status: 'succeeded', transactionId: 'local' },
      (db, p, result) => {
        executionOwnershipApplyPayment(db, p, result)
        throw new Error('结果回滚')
      },
    ),
  ).toThrow('结果回滚')
  expect(c.ownership.get(c.key)?.state).toBe('sending')
  expect(await c.idempotency.find(c.key)).toBeNull()
  expect(tasks.effect(payment)?.status).toBe('unknown')
  tasks.settle(
    claim,
    payment,
    { status: 'succeeded', transactionId: 'local' },
    executionOwnershipApplyPayment,
  )
  expect(c.ownership.get(c.key)?.state).toBe('succeeded')
  await expect(c.execute()).resolves.toMatchObject({ replayed: true })
  expect(c.gateway.withRefund).not.toHaveBeenCalled()
})
