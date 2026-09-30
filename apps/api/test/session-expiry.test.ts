/**
 * 会话生命周期 HTTP 行为
 */

import { afterEach, describe, expect, it } from 'vitest'
import { ScriptedModel } from '@aftersales/agent'
import { FrozenClock } from '@aftersales/domain'
import { composeSystem, type ComposedSystem } from '@aftersales/runtime'
import { createApp } from '../src/app.js'

const systems: ComposedSystem[] = []
const auth = { Authorization: 'Bearer cust-token-1001' }

afterEach(() => systems.splice(0).forEach((system) => system.db.close()))

describe('空闲会话收尾', () => {
  it('到期后状态 cancelled 再发消息返回 409', async () => {
    const clock = new FrozenClock('2026-09-20T12:00:00.000Z')
    const system = composeSystem({
      clock,
      model: new ScriptedModel([]),
      sessionIdleTtlHours: 1,
    })
    systems.push(system)
    const run = await system.runService.start({
      customerId: 'C1001',
      promptVersion: 'v2.5',
      model: 'scripted-v1',
    })
    await system.runService.transition(run.runId, 'running')
    await system.runService.transition(run.runId, 'awaiting_input')
    clock.advanceBy(2 * 3600 * 1000)
    expect(await system.sessionExpiry.expireDue()).toEqual([run.runId])
    const stored = await system.runService.get(run.runId)
    expect(stored.status).toBe('cancelled')
    const events = await system.eventRepo.listByRun(run.runId)
    expect(events.some((event) => event.type === 'run.expired')).toBe(true)

    const app = createApp({ system, modelAvailable: true, rateLimit: false, requestTimeout: false })
    const response = await app.request(`/api/runs/${run.runId}/messages`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '还在吗' }),
    })
    expect(response.status).toBe(409)
  })

  it('sim 来源与审批等待不被收尾', async () => {
    const clock = new FrozenClock('2026-09-20T12:00:00.000Z')
    const system = composeSystem({ clock, model: new ScriptedModel([]), sessionIdleTtlHours: 1 })
    systems.push(system)
    const sim = await system.runService.start({
      customerId: 'C1001',
      promptVersion: 'v2.5',
      model: 'scripted-v1',
      source: 'sim',
    })
    await system.runService.transition(sim.runId, 'running')
    await system.runService.transition(sim.runId, 'awaiting_input')
    const approval = await system.runService.start({
      customerId: 'C1001',
      promptVersion: 'v2.5',
      model: 'scripted-v1',
    })
    await system.runService.transition(approval.runId, 'running')
    await system.runService.transition(approval.runId, 'awaiting_approval')
    clock.advanceBy(5 * 3600 * 1000)
    expect(await system.sessionExpiry.expireDue()).toEqual([])
    expect((await system.runService.get(sim.runId)).status).toBe('awaiting_input')
    expect((await system.runService.get(approval.runId)).status).toBe('awaiting_approval')
  })
})
