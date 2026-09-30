import { serve } from '@hono/node-server'
import { ScriptedModel } from '@aftersales/agent'
import { SystemClock, KeywordPolicyScorer } from '@aftersales/domain'
import { openDatabase, loadFixture } from '@aftersales/persistence'
import { composeSystem, conversationDemoOptions } from '@aftersales/runtime'
import { createApp } from '../../src/app.js'
import { seedBusiness } from '../../../../packages/runtime/test/fixtures/business-seed.js'

const [path, paymentUrl, mode, type] = process.argv.slice(2)
if (!path || !paymentUrl) throw new Error('缺少独立实验数据库与模拟渠道')
const db = openDatabase(path)
if (!db.prepare('SELECT 1 FROM agent_runs LIMIT 1').get()) {
  loadFixture(db)
  seedBusiness(db, type, 'pending')
}
const system = composeSystem({
  db,
  withFixture: false,
  clock: new SystemClock(),
  model: new ScriptedModel([]),
  policyScorer: new KeywordPolicyScorer(),
  durableBusiness: {
    snapshot: conversationDemoOptions().snapshot,
    paymentUrl,
    leaseMs: 50,
    boundary: async (name) => {
      if (name === mode) process.exit(73)
    },
  },
})
serve(
  { hostname: '127.0.0.1', port: 0, fetch: createApp({ system, modelAvailable: false }).fetch },
  (info) => {
    process.send?.({ url: `http://127.0.0.1:${info.port}` })
    if (mode !== 'accept-only') system.durableBusiness!.start()
  },
)
