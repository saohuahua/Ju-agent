import { serve } from '@hono/node-server'
import { ScriptedModel } from '@aftersales/agent'
import { SystemClock } from '@aftersales/domain'
import { openDatabase, loadFixture } from '@aftersales/persistence'
import { composeSystem, conversationDemoOptions } from '@aftersales/runtime'
import { createApp } from '../../src/app.js'

const [path, mode] = process.argv.slice(2)
if (!path) throw new Error('缺少测试数据库')
const db = openDatabase(path)
const count = db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }
if (!count.n) loadFixture(db, [])
const options = conversationDemoOptions()
options.leaseMs = 50
options.boundary = async (name) => {
  if (name === mode) process.exit(73)
}
const system = composeSystem({
  db,
  withFixture: false,
  clock: new SystemClock(),
  model: new ScriptedModel([]),
  durableConversation: options,
})
serve(
  { hostname: '127.0.0.1', port: 0, fetch: createApp({ system, modelAvailable: true }).fetch },
  (info) => {
    process.send?.({ url: `http://127.0.0.1:${info.port}` })
    if (mode !== 'accept-only') system.conversations!.start()
  },
)
