/**
 * 限流与请求超时
 */

import { describe, expect, it } from 'vitest'
import { ScriptedModel } from '@aftersales/agent'
import { FrozenClock } from '@aftersales/domain'
import { composeSystem } from '@aftersales/runtime'
import { createApp } from '../src/app.js'
import { classifyRateLimit } from '../src/rate-limit.js'

const auth = { Authorization: 'Bearer cust-token-1001' }

describe('限流分类', () => {
  it('按端点分组', () => {
    expect(classifyRateLimit('POST', '/api/runs')?.group).toBe('create-run')
    expect(classifyRateLimit('POST', '/api/runs/r1/messages')?.group).toBe('message')
    expect(classifyRateLimit('POST', '/api/eval/run')?.group).toBe('eval')
    expect(classifyRateLimit('GET', '/api/runs/r1/events')).toBeNull()
    expect(classifyRateLimit('GET', '/api/runs')?.group).toBe('read')
  })
})

describe('HTTP 限流', () => {
  it('超过读接口限额返回 429 与 Retry-After', async () => {
    const system = composeSystem({
      clock: new FrozenClock('2026-09-20T12:00:00.000Z'),
      model: new ScriptedModel([]),
    })
    const app = createApp({
      system,
      modelAvailable: true,
      rateLimit: { readPerMinute: 2, now: () => 1_000 },
      requestTimeout: false,
    })
    const send = () => app.request('/api/runs', { headers: auth })
    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(200)
    const blocked = await send()
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('Retry-After')).toBeTruthy()
    const body = (await blocked.json()) as { error: string }
    expect(body.error).toBe('RATE_LIMITED')
    system.db.close()
  })
})
