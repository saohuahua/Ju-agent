import { expect, it } from 'vitest'
import { createMemoryDatabase } from '../../../packages/persistence/src/db.js'
import { migrateP6 } from '../../../packages/persistence/src/p6-migration.js'
import { P6TaskRepository } from '../../../packages/persistence/src/p6-task-repository.js'
import { createP6DurableApi } from '../src/p6-durable-api.js'

it('P6 HTTP 在返回受理前持久化 重试复用快照 异参和越权被拒绝', async () => {
  const db = createMemoryDatabase()
  migrateP6(db)
  try {
    const repository = new P6TaskRepository(db)
    let preparations = 0
    const app = createP6DurableApi({
      repository,
      customer: async (context) => context.req.header('Test-Customer') ?? null,
      prepare: async (body, customerId) => {
        preparations++
        return {
          customerId,
          requestKey: '',
          kind: 'start',
          config: {
            snapshotId: `snapshot-${preparations}`,
            provider: 'scripted',
            model: 'scripted',
            promptVersion: 'p6',
            value: {},
          },
          plan: { input: String(body.message), tool: 'readonly' },
        }
      },
    })
    const post = (message: string) =>
      app.request('/commands', {
        method: 'POST',
        headers: {
          'Idempotency-Key': 'key-1',
          'Test-Customer': 'C1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message }),
      })
    const first = await post('帮助查询')
    expect(first.status).toBe(202)
    const accepted = (await first.json()) as { taskId: string; runId: string }
    expect(repository.get(accepted.taskId)?.input.config.snapshotId).toBe('snapshot-1')
    expect(db.prepare('SELECT run_id AS runId FROM agent_runs').get()).toEqual({
      runId: accepted.runId,
    })
    const repeat = await post('帮助查询')
    expect(repeat.status).toBe(200)
    expect(((await repeat.json()) as { taskId: string }).taskId).toBe(accepted.taskId)
    expect(preparations).toBe(1)
    expect((await post('改动请求')).status).toBe(409)
    expect(
      (await app.request(`/commands/${accepted.taskId}`, { headers: { 'Test-Customer': 'other' } }))
        .status,
    ).toBe(404)
    expect((await app.request('/commands', { method: 'POST' })).status).toBe(401)
    const visible = await app.request(`/commands/${accepted.taskId}`, {
      headers: { 'Test-Customer': 'C1' },
    })
    expect(await visible.json()).toEqual({
      taskId: accepted.taskId,
      runId: accepted.runId,
      status: 'queued',
      cancelRequested: false,
    })
    expect(
      (
        await app.request(`/commands/${accepted.taskId}/cancel`, {
          method: 'POST',
          headers: { 'Test-Customer': 'C1' },
        })
      ).status,
    ).toBe(202)
    expect(repository.get(accepted.taskId)?.cancelRequested).toBe(1)
  } finally {
    db.close()
  }
})
