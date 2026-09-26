import { afterEach, describe, expect, it } from 'vitest'
import { ScriptedModel } from '@aftersales/agent'
import { FrozenClock } from '@aftersales/domain'
import { composeSystem, type ComposedSystem } from '@aftersales/runtime'
import { p6ReadyPayment } from '@aftersales/persistence'
import { createApp } from '../src/app.js'

const systems: ComposedSystem[] = []
const actor = { role: 'operator' as const }
const headers = { Authorization: 'Bearer operator-token', 'Content-Type': 'application/json' }
afterEach(() => {
  for (const system of systems.splice(0)) system.db.close()
})

/** 正式组合根与路由读取同一持久任务 不依赖前端隐藏判断安全性 */
async function fixture() {
  const system = composeSystem({
    clock: new FrozenClock('2026-09-20T12:00:00Z'),
    model: new ScriptedModel([]),
  })
  systems.push(system)
  const run = await system.runService.start({
    customerId: 'C1001',
    model: 'test',
    promptVersion: 'test',
  })
  await system.runService.transition(run.runId, 'running')
  await system.runService.transition(run.runId, 'escalated')
  await system.handoverService.takeOver(actor, run.runId)
  const app = createApp({ system, modelAvailable: false })
  return {
    system,
    run,
    app,
    close: () =>
      app.request(`/api/runs/${run.runId}/resolve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ summary: '人工核验' }),
      }),
  }
}

const config = {
  snapshotId: 'test-only',
  provider: 'fixture',
  model: 'test',
  promptVersion: 'test',
  value: {},
}

describe('正式接口的持久任务核验', () => {
  it.each(['queued', 'running', 'needs_confirmation'])(
    '持久任务 %s 时阻止无业务审计的案件结案',
    async (status) => {
      const f = await fixture()
      const task = f.system.durableTasks.accept({
        requestKey: 'review',
        customerId: 'C1001',
        runId: f.run.runId,
        kind: 'start',
        config,
        plan: { input: '测试', tool: 'read_only' },
      })
      f.system.db
        .prepare('UPDATE p6_tasks SET status = ? WHERE task_id = ?')
        .run(status, task.taskId)
      expect((await f.close()).status).toBe(409)
      const detail = (await (
        await f.app.request(`/api/desk/cases/${f.run.runId}`, { headers })
      ).json()) as { closure: { blockers: Array<{ resourceType: string; status: string }> } }
      expect(detail.closure.blockers).toContainEqual(
        expect.objectContaining({ resourceType: 'task', status }),
      )
    },
  )

  it('任务完成但渠道结果未知仍阻止结案', async () => {
    const f = await fixture()
    const compensation = await f.system.compensationService.createCompensation(actor, {
      orderNo: 'SO-2026-0003',
      reason: 'service_apology',
      amountCents: 100,
    })
    const payment = p6ReadyPayment(
      f.system.db,
      'compensation',
      compensation.compensationNo,
      'C1001',
    )
    const task = f.system.durableTasks.accept({
      requestKey: 'payment',
      customerId: 'C1001',
      runId: f.run.runId,
      kind: 'start',
      config,
      plan: { input: '测试', tool: 'compensation', payment },
    })
    const claim = f.system.durableTasks.claim('test', 10000, {
      global: 1,
      customer: 1,
      provider: 1,
      tool: 1,
    })!
    f.system.durableTasks.beginPayment(claim, payment)
    f.system.durableTasks.settle(
      claim,
      payment,
      { status: 'unknown', reason: '响应丢失' },
      () => {},
    )
    f.system.durableTasks.finish(claim, 'completed')
    f.system.db
      .prepare("UPDATE compensations SET status = 'succeeded' WHERE compensation_no = ?")
      .run(compensation.compensationNo)
    expect(f.system.durableTasks.get(task.taskId)?.status).toBe('completed')
    expect((await f.close()).status).toBe(409)
  })

  it('审批待核验覆盖笼统运行中且客户拿不到内部任务配置', async () => {
    const f = await fixture()
    const compensation = await f.system.compensationService.createCompensation(actor, {
      orderNo: 'SO-2026-0003',
      reason: 'service_apology',
      amountCents: 100,
    })
    const approval = await f.system.approvalService.create({
      runId: f.run.runId,
      resourceType: 'compensation',
      resourceId: compensation.compensationNo,
      amountCents: 100,
      reason: '测试',
      requestedBy: 'workflow',
    })
    const now = f.system.clock.now().toISOString()
    f.system.db
      .prepare("UPDATE approval_requests SET status = 'approved' WHERE approval_id = ?")
      .run(approval.approvalId)
    f.system.db
      .prepare(
        `INSERT INTO approval_execution_intents (approval_id, run_id, decision, decided_by, status, created_at, updated_at)
      VALUES (?, ?, 'approved', 'supervisor', 'running', ?, ?)`,
      )
      .run(approval.approvalId, f.run.runId, now, now)
    const task = f.system.durableTasks.accept({
      requestKey: 'approval',
      customerId: 'C1001',
      runId: f.run.runId,
      approvalId: approval.approvalId,
      kind: 'approval',
      config,
      plan: { input: '内部计划不可公开', tool: 'compensation' },
    })
    f.system.db
      .prepare("UPDATE p6_tasks SET status = 'needs_confirmation' WHERE task_id = ?")
      .run(task.taskId)
    const response = await f.app.request('/api/approvals/executions', { headers })
    expect(await response.json()).toMatchObject({
      executions: [
        expect.objectContaining({
          taskStatus: 'needs_confirmation',
          outcome: 'unknown',
          status: 'running',
        }),
      ],
    })
    expect(
      (
        await f.app.request('/api/approvals/executions', {
          headers: { Authorization: 'Bearer cust-token-1001' },
        })
      ).status,
    ).toBe(403)
  })
})
