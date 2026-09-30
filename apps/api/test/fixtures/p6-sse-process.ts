import { serve } from '@hono/node-server'
import { openDatabase } from '../../../../packages/persistence/src/db.js'
import { migrateP6 } from '../../../../packages/persistence/src/p6-migration.js'
import { P6TaskRepository } from '../../../../packages/persistence/src/p6-task-repository.js'
import { createP6DurableApi } from '../../src/p6-durable-api.js'

const path = process.argv[2]
if (!path) throw new Error('缺少实验数据库路径')
const db = openDatabase(path)
migrateP6(db)
const repo = new P6TaskRepository(db)
const task = repo.accept({
  customerId: 'C1',
  requestKey: 'sse',
  kind: 'start',
  source: 'sim',
  config: {
    snapshotId: 'sse-v1',
    model: 'scripted',
    provider: 'scripted',
    promptVersion: 'v1',
    value: {},
  },
  plan: { input: 'sse', tool: 'readonly' },
})
const claim = repo.claim('sse-fixture', 30_000, { global: 1, customer: 1, provider: 1, tool: 1 })!
repo.checkpoint(claim, 'model', { private: '内部模型结果禁止展示' })
const app = createP6DurableApi({
  repository: repo,
  customer: async (context) => context.req.header('Test-Customer') ?? null,
  prepare: async () => {
    throw new Error('此夹具不新增命令')
  },
})
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (address) => {
  process.send?.({ url: `http://127.0.0.1:${address.port}`, taskId: task.taskId })
})
process.on('message', (message) => {
  if (message === 'continue') {
    repo.checkpoint(claim, 'read', { private: '内部工具结果禁止展示' })
    repo.finish(claim, 'completed')
    process.send?.({ finished: true })
  }
})
