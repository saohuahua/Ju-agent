import { afterEach, expect, it } from 'vitest'
import { ScriptedModel } from '@aftersales/agent'
import { FrozenClock, KeywordPolicyScorer } from '@aftersales/domain'
import { composeSystem, BASELINE_FROZEN_TIME } from '@aftersales/runtime'
import { createApp } from '../src/app.js'

const systems: ReturnType<typeof composeSystem>[] = []
afterEach(() => {
  for (const system of systems.splice(0)) system.db.close()
})
function setup() {
  const system = composeSystem({
    clock: new FrozenClock(BASELINE_FROZEN_TIME),
    model: new ScriptedModel([]),
    policyScorer: new KeywordPolicyScorer(),
  })
  systems.push(system)
  return { system, app: createApp({ system, modelAvailable: false }) }
}
const headers = { Authorization: 'Bearer operator-token', 'Content-Type': 'application/json' }

it('正式 L2 API 显式离线执行并持久保存仅内部可读费用附件', async () => {
  const { system, app } = setup()
  const started = await app.request('/api/eval/run-sim', {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode: 'simulation', caseId: 'hp_query_order_status' }),
  })
  expect(started.status).toBe(200)
  const { taskId } = (await started.json()) as { taskId: string }
  let reportId = ''
  for (let i = 0; i < 100; i++) {
    const response = await app.request(`/api/eval/sim-tasks/${taskId}`, { headers })
    const { task } = (await response.json()) as {
      task: { status: string; reportId: string; error: string }
    }
    if (task.status === 'error') throw new Error(task.error)
    if (task.status === 'done') {
      reportId = task.reportId
      break
    }
    await new Promise((done) => setTimeout(done, 10))
  }
  expect(reportId).toBeTruthy()
  const response = await app.request(`/api/eval/reports/${reportId}/evidence`, { headers })
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    evidence: { mode: string; costs: { currency: string; unit: string; calls: unknown[] } }
  }
  expect(body.evidence.mode).toBe('simulation')
  expect(body.evidence.costs.currency).toBe('CNY')
  expect(body.evidence.costs.unit).toBe('micro_yuan')
  expect(body.evidence.costs.calls.length).toBeGreaterThan(0)
  expect(
    (
      await app.request(`/api/eval/reports/${reportId}/evidence`, {
        headers: { Authorization: 'Bearer cust-token-1001' },
      })
    ).status,
  ).toBe(403)
  expect(system.db.prepare('SELECT count(*) AS n FROM eval_budget_evidence').get()).toEqual({
    n: 1,
  })
})

it('正式评测 API 不接受隐式真实调用与裸模型覆盖', async () => {
  const { system, app } = setup()
  for (const body of [{}, { mode: 'live' }]) {
    expect(
      (
        await app.request('/api/eval/run-sim', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(503)
  }
  for (const body of [
    { mode: 'simulation', repeat: 1.5 },
    { mode: 'simulation', agentModel: 'external' },
  ]) {
    expect(
      (
        await app.request('/api/eval/run-sim', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(400)
  }
  expect(system.db.prepare('SELECT count(*) AS n FROM p7_calls').get()).toEqual({ n: 0 })
})
