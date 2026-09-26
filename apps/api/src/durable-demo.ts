import { serve } from '@hono/node-server'
import { ScriptedModel } from '@aftersales/agent'
import { SystemClock, KeywordPolicyScorer } from '@aftersales/domain'
import { openDatabase, loadFixture } from '@aftersales/persistence'
import { composeSystem, conversationDemoOptions } from '@aftersales/runtime'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'

/** 独立持久演示库 不加载环境密钥 重复启动不会覆盖已有会话 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const db = openDatabase(resolve(root, 'data/durable-demo.db'))
const count = db.prepare('SELECT COUNT(*) AS count FROM orders').get() as { count: number }
if (!count.count) loadFixture(db, [])
const system = composeSystem({
  db,
  withFixture: false,
  clock: new SystemClock(),
  model: new ScriptedModel([]),
  policyScorer: new KeywordPolicyScorer(),
  durableConversation: conversationDemoOptions(),
})
system.conversations!.start()
const server = serve(
  { hostname: '127.0.0.1', port: 8787, fetch: createApp({ system, modelAvailable: true }).fetch },
  () => console.log('持久普通会话演示 API http://127.0.0.1:8787 数据库 data/durable-demo.db'),
)
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.close(() => {
      void system.conversations!.stop().then(() => {
        db.close()
        process.exit(0)
      })
    })
  })
