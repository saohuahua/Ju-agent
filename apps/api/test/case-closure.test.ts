import { afterEach, describe, expect, it } from 'vitest'
import { ScriptedModel } from '@aftersales/agent'
import { FrozenClock } from '@aftersales/domain'
import { composeSystem, type ComposedSystem } from '@aftersales/runtime'
import { createApp } from '../src/app.js'

const systems: ComposedSystem[] = []
const operator = { role: 'operator' as const }
const headers = { Authorization: 'Bearer operator-token', 'Content-Type': 'application/json' }

afterEach(() => {
  for (const system of systems.splice(0)) system.db.close()
})

/** 每个用例使用内存数据库与模拟网关 不访问模型或真实支付 */
async function fixture() {
  const system = composeSystem({
    clock: new FrozenClock('2026-09-20T12:00:00Z'),
    model: new ScriptedModel([]),
  })
  systems.push(system)
  const app = createApp({ system, modelAvailable: false })
  const run = await system.runService.start({
    customerId: 'C1001',
    model: 'fixture',
    promptVersion: 'test',
  })
  await system.runService.transition(run.runId, 'running')
  await system.runService.transition(run.runId, 'escalated')
  await system.handoverService.takeOver(operator, run.runId)
  const resolve = () =>
    app.request(`/api/runs/${run.runId}/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ summary: '测试渠道处理完成' }),
    })
  const review = () => system.handoverService.reviewClosure(operator, run.runId)
  return { system, app, run, resolve, review }
}

describe('人工结案资金核验', () => {
  it('退款补偿价保逐项完成后才允许结案且重复提交不重复写事件', async () => {
    const f = await fixture()
    const refund = await f.system.afterSaleService.createReturnRequest(
      operator,
      {
        orderNo: 'SO-2026-0001',
        type: 'refund_only',
        reason: 'unshipped_cancel',
        itemIds: ['item-0001-1'],
      },
      f.run.runId,
    )
    const compensation = await f.system.compensationService.createCompensation(
      operator,
      {
        orderNo: 'SO-2026-0003',
        reason: 'service_apology',
        amountCents: 100,
      },
      f.run.runId,
    )
    const protection = await f.system.priceProtectionService.createPriceProtection(
      operator,
      {
        orderNo: 'SO-2026-0011',
      },
      f.run.runId,
    )
    expect((await f.review()).blockers.map((item) => item.resourceType)).toEqual(
      expect.arrayContaining(['refund', 'compensation', 'price_protection']),
    )
    expect((await f.resolve()).status).toBe(409)
    await f.system.afterSaleService.executeRefund(
      operator,
      { returnNo: refund.returnNo },
      f.run.runId,
    )
    await f.system.compensationService.executeCompensation(
      operator,
      { compensationNo: compensation.compensationNo },
      f.run.runId,
    )
    expect((await f.resolve()).status).toBe(409)
    await f.system.priceProtectionService.executePriceProtection(
      operator,
      { protectionNo: protection.protectionNo },
      f.run.runId,
    )
    expect((await f.review()).canResolve).toBe(true)
    const responses = await Promise.all([f.resolve(), f.resolve()])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    expect(
      (await f.system.eventRepo.listByRun(f.run.runId)).filter(
        (event) => event.type === 'run.resolved',
      ),
    ).toHaveLength(1)
    expect(
      f.system.db
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_logs WHERE run_id = ? AND action = 'run_resolved'",
        )
        .get(f.run.runId),
    ).toEqual({ count: 1 })
  })

  it.each(['created', 'executing', 'failed', 'unknown'])(
    '退款状态 %s 阻止结案 即使父单已经完成',
    async (status) => {
      const f = await fixture()
      const record = await f.system.afterSaleService.createReturnRequest(
        operator,
        {
          orderNo: 'SO-2026-0001',
          type: 'refund_only',
          reason: 'unshipped_cancel',
        },
        f.run.runId,
      )
      // 注入父子单不一致以覆盖异常持久状态
      f.system.db
        .prepare("UPDATE return_requests SET status = 'completed' WHERE return_no = ?")
        .run(record.returnNo)
      f.system.db
        .prepare('UPDATE refunds SET status = ? WHERE refund_no = ?')
        .run(status, record.refundNo)
      expect((await f.resolve()).status).toBe(409)
      expect((await f.review()).blockers).toEqual(
        expect.arrayContaining([expect.objectContaining({ resourceType: 'refund', status })]),
      )
    },
  )

  it('预览通过后新增未执行补偿 提交时重新核验', async () => {
    const f = await fixture()
    expect((await f.review()).canResolve).toBe(true)
    await f.system.compensationService.createCompensation(
      operator,
      {
        orderNo: 'SO-2026-0003',
        reason: 'service_apology',
        amountCents: 100,
      },
      f.run.runId,
    )
    expect((await f.resolve()).status).toBe(409)
    expect((await f.system.runService.get(f.run.runId)).status).toBe('handling_human')
  })

  it.each(['failed', 'executing', 'unknown'])('补偿与价保状态 %s 都不能结案', async (status) => {
    const f = await fixture()
    const compensation = await f.system.compensationService.createCompensation(
      operator,
      {
        orderNo: 'SO-2026-0003',
        reason: 'service_apology',
        amountCents: 100,
      },
      f.run.runId,
    )
    const protection = await f.system.priceProtectionService.createPriceProtection(
      operator,
      {
        orderNo: 'SO-2026-0011',
      },
      f.run.runId,
    )
    f.system.db
      .prepare('UPDATE compensations SET status = ? WHERE compensation_no = ?')
      .run(status, compensation.compensationNo)
    f.system.db
      .prepare('UPDATE price_protections SET status = ? WHERE protection_no = ?')
      .run(status, protection.protectionNo)
    expect((await f.review()).blockers.map((item) => item.resourceType).sort()).toEqual([
      'compensation',
      'price_protection',
    ])
    expect((await f.resolve()).status).toBe(409)
  })

  it('审批拒绝并联动取消退款后允许结案', async () => {
    const f = await fixture()
    const record = await f.system.afterSaleService.createReturnRequest(
      operator,
      {
        orderNo: 'SO-2026-0001',
        type: 'refund_only',
        reason: 'unshipped_cancel',
      },
      f.run.runId,
    )
    await f.system.afterSaleService.applyApprovalDecision(
      operator,
      record.returnNo,
      'rejected',
      f.run.runId,
    )
    expect((await f.resolve()).status).toBe(200)
  })

  it.each(['pending', 'running'])('审批执行意图 %s 时阻止结案', async (status) => {
    const f = await fixture()
    const now = f.system.clock.now().toISOString()
    const approval = await f.system.approvalService.create({
      runId: null,
      resourceType: 'compensation',
      resourceId: 'fixture',
      reason: '测试执行意图',
      amountCents: 100,
      requestedBy: 'workflow',
    })
    f.system.db
      .prepare(
        `INSERT INTO approval_execution_intents
      (approval_id, run_id, decision, decided_by, status, created_at, updated_at)
      VALUES (?, ?, 'approved', 'supervisor', ?, ?, ?)`,
      )
      .run(approval.approvalId, f.run.runId, status, now, now)
    expect((await f.resolve()).status).toBe(409)
    expect((await f.review()).blockers).toEqual([
      expect.objectContaining({ resourceType: 'execution', status }),
    ])
  })

  it.each(['{broken', '{"refundNo":123}'])('损坏的断点关联不能静默跳过 %s', async (state) => {
    const f = await fixture()
    f.system.db
      .prepare(
        'INSERT INTO checkpoints (run_id, step_id, state_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(f.run.runId, 'test', state, f.system.clock.now().toISOString())
    expect((await f.review()).blockers).toEqual([
      expect.objectContaining({ resourceType: 'evidence', status: 'unverified' }),
    ])
    expect((await f.resolve()).status).toBe(409)
  })

  it('同客户其他案件的补偿不阻止当前案件结案', async () => {
    const f = await fixture()
    const other = await f.system.runService.start({
      customerId: 'C1001',
      model: 'fixture',
      promptVersion: 'test',
    })
    await f.system.compensationService.createCompensation(
      operator,
      {
        orderNo: 'SO-2026-0003',
        reason: 'service_apology',
        amountCents: 100,
      },
      other.runId,
    )
    expect((await f.resolve()).status).toBe(200)
  })

  it('关联单缺失与跨客户归属都阻止结案', async () => {
    const f = await fixture()
    f.system.db
      .prepare(
        'INSERT INTO checkpoints (run_id, step_id, state_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        f.run.runId,
        'test',
        JSON.stringify({ compensationNo: 'missing' }),
        f.system.clock.now().toISOString(),
      )
    const record = await f.system.compensationService.createCompensation(
      operator,
      {
        orderNo: 'SO-2026-0004',
        reason: 'service_apology',
        amountCents: 100,
      },
      f.run.runId,
    )
    expect((await f.review()).blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceId: 'missing', status: 'missing' }),
        expect.objectContaining({ resourceId: record.compensationNo, status: 'unverified' }),
      ]),
    )
    expect((await f.resolve()).status).toBe(409)
  })

  it('审计写入失败时状态与客户事件一起回滚', async () => {
    const f = await fixture()
    f.system.db.exec(`CREATE TRIGGER fail_closure BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'run_resolved' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`)
    await expect(f.system.handoverService.resolve(operator, f.run.runId, '完成')).rejects.toThrow(
      'injected failure',
    )
    expect((await f.system.runService.get(f.run.runId)).status).toBe('handling_human')
    expect(
      (await f.system.eventRepo.listByRun(f.run.runId)).filter(
        (event) => event.type === 'run.resolved',
      ),
    ).toHaveLength(0)
  })

  it('客户不能读取团队核验结果或直接结案', async () => {
    const f = await fixture()
    const customerHeaders = { ...headers, Authorization: 'Bearer cust-token-1001' }
    expect(
      (await f.app.request(`/api/desk/cases/${f.run.runId}`, { headers: customerHeaders })).status,
    ).toBe(403)
    expect(
      (
        await f.app.request(`/api/runs/${f.run.runId}/resolve`, {
          method: 'POST',
          headers: customerHeaders,
          body: JSON.stringify({ summary: '完成' }),
        })
      ).status,
    ).toBe(403)
  })
})
