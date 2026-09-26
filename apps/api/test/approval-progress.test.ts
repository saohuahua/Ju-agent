import { afterEach, describe, expect, it } from 'vitest'
import { ScriptedModel } from '@aftersales/agent'
import { ApprovalExecutionsResponse } from '@aftersales/contracts'
import { FrozenClock } from '@aftersales/domain'
import { composeSystem, type ComposedSystem } from '@aftersales/runtime'
import { createApp } from '../src/app.js'

const systems: ComposedSystem[] = []
const actor = { role: 'operator' as const }
const headers = { Authorization: 'Bearer operator-token' }
afterEach(() => {
  for (const system of systems.splice(0)) system.db.close()
})

/** 构造持久状态快照 模拟进程在审批后的不同阶段停止 */
async function fixture(
  kind: 'compensation' | 'return_request' | 'price_protection' = 'compensation',
) {
  const system = composeSystem({
    clock: new FrozenClock('2026-09-20T12:00:00Z'),
    model: new ScriptedModel([]),
  })
  systems.push(system)
  const run = await system.runService.start({
    customerId: 'C1001',
    model: 'fixture',
    promptVersion: 'test',
  })
  let id: string
  if (kind === 'compensation') {
    id = (
      await system.compensationService.createCompensation(
        actor,
        {
          orderNo: 'SO-2026-0003',
          reason: 'service_apology',
          amountCents: 100,
        },
        run.runId,
      )
    ).compensationNo
  } else if (kind === 'price_protection') {
    id = (
      await system.priceProtectionService.createPriceProtection(
        actor,
        { orderNo: 'SO-2026-0011' },
        run.runId,
      )
    ).protectionNo
  } else {
    id = (
      await system.afterSaleService.createReturnRequest(
        actor,
        {
          orderNo: 'SO-2026-0001',
          type: 'refund_only',
          reason: 'unshipped_cancel',
        },
        run.runId,
      )
    ).returnNo
  }
  const approval = await system.approvalService.create({
    runId: run.runId,
    resourceType: kind,
    resourceId: id,
    reason: '执行进度测试快照',
    amountCents: 100,
    requestedBy: 'workflow',
  })
  const now = system.clock.now().toISOString()
  system.db
    .prepare("UPDATE approval_requests SET status = 'approved' WHERE approval_id = ?")
    .run(approval.approvalId)
  system.db
    .prepare(
      `INSERT INTO approval_execution_intents
    (approval_id, run_id, decision, decided_by, status, created_at, updated_at)
    VALUES (?, ?, 'approved', 'supervisor', 'completed', ?, ?)`,
    )
    .run(approval.approvalId, run.runId, now, now)
  const app = createApp({ system, modelAvailable: false })
  const read = async () => {
    const response = await app.request('/api/approvals/executions', { headers })
    expect(response.status).toBe(200)
    return ApprovalExecutionsResponse.parse(await response.json())
  }
  return { system, app, id, approval, read }
}

describe('审批执行进度业务事实', () => {
  it.each([
    ['auto_approved', 'pending'],
    ['executing', 'running'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
    ['cancelled', 'closed'],
    ['unknown', 'unknown'],
  ])('补偿状态 %s 映射为 %s 而非根据调用完成推断', async (status, expected) => {
    const f = await fixture()
    f.system.db
      .prepare('UPDATE compensations SET status = ? WHERE compensation_no = ?')
      .run(status, f.id)
    expect((await f.read()).executions[0]).toMatchObject({ status: 'completed', outcome: expected })
  })

  it('价保使用真实业务结果并且不返回令牌或原始异常', async () => {
    const f = await fixture('price_protection')
    await f.system.priceProtectionService.executePriceProtection(actor, { protectionNo: f.id })
    f.system.db
      .prepare(
        "UPDATE approval_execution_intents SET status = 'failed', last_error = 'secret-token phone 13812345678'",
      )
      .run()
    const body = await f.read()
    expect(body.executions[0]).toMatchObject({ status: 'failed', outcome: 'succeeded' })
    expect(JSON.stringify(body)).not.toContain('secret-token')
    expect(JSON.stringify(body)).not.toContain('13812345678')
    expect(JSON.stringify(body)).not.toContain(f.approval.oneTimeToken)
  })

  it('售后单完成但退款失败不能显示执行成功', async () => {
    const f = await fixture('return_request')
    f.system.db
      .prepare("UPDATE return_requests SET status = 'completed' WHERE return_no = ?")
      .run(f.id)
    f.system.db.prepare("UPDATE refunds SET status = 'failed' WHERE return_no = ?").run(f.id)
    expect((await f.read()).executions[0]?.outcome).toBe('failed')
    f.system.db.prepare("UPDATE refunds SET status = 'succeeded' WHERE return_no = ?").run(f.id)
    expect((await f.read()).executions[0]?.outcome).toBe('succeeded')
    f.system.db.prepare('DELETE FROM refunds WHERE return_no = ?').run(f.id)
    expect((await f.read()).executions[0]?.outcome).toBe('unknown')
  })

  it('退货等待与拒绝分别展示 不将恢复结束当作完成', async () => {
    const f = await fixture('return_request')
    f.system.db
      .prepare(
        "UPDATE return_requests SET type = 'return', status = 'awaiting_buyer_shipment' WHERE return_no = ?",
      )
      .run(f.id)
    expect((await f.read()).executions[0]?.outcome).toBe('waiting_return')
    f.system.db
      .prepare("UPDATE return_requests SET status = 'rejected' WHERE return_no = ?")
      .run(f.id)
    f.system.db.prepare("UPDATE refunds SET status = 'cancelled' WHERE return_no = ?").run(f.id)
    expect((await f.read()).executions[0]?.outcome).toBe('closed')
  })

  it('业务记录缺失或跨客户关联都返回未知且客户不能读取', async () => {
    const f = await fixture()
    f.system.db
      .prepare(
        "UPDATE compensations SET customer_id = 'C1002', status = 'succeeded' WHERE compensation_no = ?",
      )
      .run(f.id)
    expect((await f.read()).executions[0]).toMatchObject({
      outcome: 'unknown',
      businessStatus: null,
    })
    f.system.db.prepare('DELETE FROM compensations WHERE compensation_no = ?').run(f.id)
    expect((await f.read()).executions[0]?.outcome).toBe('unknown')
    expect(
      (
        await f.app.request('/api/approvals/executions', {
          headers: { Authorization: 'Bearer cust-token-1001' },
        })
      ).status,
    ).toBe(403)
  })
})
