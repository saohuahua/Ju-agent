import { expect, it } from 'vitest'
import { composeSystem } from '@aftersales/runtime'
import { ScriptedModel } from '@aftersales/agent'
import { SystemClock } from '@aftersales/domain'
import { createMemoryDatabase, startP6PaymentSimulator } from '@aftersales/persistence'
import { createApp } from '../src/app.js'
import { createEventStream } from '../src/sse.js'

it('存活与依赖就绪分开 且停止后拒绝新请求', async () => {
  const system = composeSystem({ clock: new SystemClock(), model: new ScriptedModel([]) })
  const shutdown = new AbortController()
  try {
    const app = createApp({
      system,
      modelAvailable: false,
      readiness: async () => false,
      shutdownSignal: shutdown.signal,
    })
    expect((await app.request('/api/health')).status).toBe(200)
    expect((await app.request('/api/ready')).status).toBe(503)
    shutdown.abort()
    expect((await app.request('/api/health')).status).toBe(503)
  } finally {
    system.db.close()
  }
})

it('原模拟渠道健康检查不产生资金或查询记录', async () => {
  const db = createMemoryDatabase()
  const server = await startP6PaymentSimulator(db)
  try {
    const changes = db.prepare('SELECT total_changes() AS n').get()
    const port = (server.address() as { port: number }).port
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes)
    expect(db.prepare('SELECT COUNT(*) AS n FROM p6_channel').get()).toEqual({ n: 0 })
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
    db.close()
  }
})

it('停止信号终止非终态 SSE 轮询', async () => {
  const shutdown = new AbortController()
  const stream = createEventStream(
    {
      signal: shutdown.signal,
      listEvents: async () => [],
      isRunTerminal: async () => false,
      pollIntervalMs: 1,
    },
    'run',
    0,
  )
  const reader = stream.getReader()
  await reader.read()
  const pending = reader.read()
  shutdown.abort()
  expect((await pending).done).toBe(true)
})
