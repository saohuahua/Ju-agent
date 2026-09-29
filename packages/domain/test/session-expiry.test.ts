/**
 * 空闲会话收尾
 */

import { describe, expect, it } from 'vitest'
import { FrozenClock } from '../src/clock.js'
import { DomainError } from '../src/repositories.js'
import { createToolError } from '@aftersales/contracts'
import { SessionExpiryService } from '../src/services/session-expiry-service.js'
import type { AgentRunRecord } from '../src/entities.js'
import type { RunService } from '../src/services/run-service.js'

function record(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    runId: 'run_idle1',
    customerId: 'C1001',
    status: 'awaiting_input',
    intent: null,
    promptVersion: 'v2.5',
    model: 'scripted-v1',
    error: null,
    faultPlan: [],
    source: 'customer',
    createdAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-20T12:00:00.000Z',
    ...overrides,
  }
}

function fakeRuns(initial: AgentRunRecord[]) {
  const rows = new Map(initial.map((item) => [item.runId, item]))
  const events: Array<{ runId: string; type: string; payload: unknown }> = []
  const service = {
    async list(options?: { status?: string }) {
      return [...rows.values()].filter((item) => !options?.status || item.status === options.status)
    },
    async transition(
      runId: string,
      to: AgentRunRecord['status'],
      _patch?: unknown,
      expected?: string,
    ) {
      const current = rows.get(runId)
      if (!current || (expected && current.status !== expected)) {
        throw new DomainError(createToolError('CONFLICT', '状态已变化'))
      }
      const updated = { ...current, status: to }
      rows.set(runId, updated)
      return updated
    },
    async emit(runId: string, type: string, payload: unknown) {
      events.push({ runId, type, payload })
      return events.length
    },
  }
  return { service: service as unknown as RunService, rows, events }
}

describe('SessionExpiryService', () => {
  it('过期客户会话迁往 cancelled 并落 run.expired', async () => {
    const clock = new FrozenClock('2026-09-23T13:00:00.000Z')
    const { service, rows, events } = fakeRuns([record()])
    const expiry = new SessionExpiryService({
      runs: service,
      clock,
      ttlHours: 72,
      guards: { isBusy: () => false, hasRefundLink: () => false },
    })
    expect(await expiry.expireDue()).toEqual(['run_idle1'])
    expect(rows.get('run_idle1')?.status).toBe('cancelled')
    expect(events[0]).toMatchObject({ type: 'run.expired', payload: { reason: 'idle_ttl' } })
  })

  it('评测会话 在途任务 退款关联与未到期会话不被收尾', async () => {
    const clock = new FrozenClock('2026-09-23T13:00:00.000Z')
    const { service, rows } = fakeRuns([
      record({ runId: 'sim', source: 'sim' }),
      record({ runId: 'busy' }),
      record({ runId: 'refund' }),
      record({ runId: 'fresh', updatedAt: '2026-09-23T12:30:00.000Z' }),
    ])
    const expiry = new SessionExpiryService({
      runs: service,
      clock,
      ttlHours: 72,
      guards: {
        isBusy: (id) => id === 'busy',
        hasRefundLink: (id) => id === 'refund',
      },
    })
    expect(await expiry.expireDue()).toEqual([])
    expect([...rows.values()].every((item) => item.status === 'awaiting_input')).toBe(true)
  })

  it('并发 CAS 冲突时跳过', async () => {
    const clock = new FrozenClock('2026-09-23T13:00:00.000Z')
    const { service } = fakeRuns([record()])
    let calls = 0
    const wrapped = {
      ...service,
      async transition(...args: Parameters<RunService['transition']>) {
        calls += 1
        if (calls === 1) throw new DomainError(createToolError('CONFLICT', '状态已变化'))
        return service.transition(...args)
      },
    } as RunService
    const expiry = new SessionExpiryService({
      runs: wrapped,
      clock,
      ttlHours: 72,
      guards: { isBusy: () => false, hasRefundLink: () => false },
    })
    expect(await expiry.expireDue()).toEqual([])
  })
})
