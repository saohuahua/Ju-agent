import { serve } from '@hono/node-server'
import { ScriptedModel } from '@aftersales/agent'
import { SystemClock, KeywordPolicyScorer } from '@aftersales/domain'
import { openDatabase, loadFixture } from '@aftersales/persistence'
import { composeSystem } from '@aftersales/runtime'
import { createApp } from '../../src/app.js'
import { refundConversationOptions } from './refund-conversation-options.js'

const [path, paymentUrl, mode, scenario] = process.argv.slice(2)
if (!path || !paymentUrl) throw new Error('必须提供独立实验数据库及本地渠道')
const db = openDatabase(path)
if (!db.prepare('SELECT 1 FROM orders LIMIT 1').get()) {
  loadFixture(db)
  const returning = scenario === 'return'
  db.prepare(
    "UPDATE orders SET total_amount_cents = ?, status = ?, shipped_at = ?, delivered_at = ? WHERE order_no = 'SO-2026-0001'",
  ).run(
    scenario === 'approval' || returning ? 699900 : 29900,
    returning ? 'delivered' : 'paid',
    returning ? new Date().toISOString() : null,
    returning ? new Date().toISOString() : null,
  )
}
const conversation = refundConversationOptions(
  scenario === 'return' ? 'submit_return' : 'submit_refund_only',
  scenario === 'return' ? 'quality' : 'unshipped_cancel',
)
const boundary = async (name: string) => {
  if (name === mode) {
    console.log(`故障边界 ${name}`)
    process.exit(73)
  }
}
const system = composeSystem({
  db,
  withFixture: false,
  clock: new SystemClock(),
  model: new ScriptedModel([]),
  policyScorer: new KeywordPolicyScorer(),
  durableConversation: { ...conversation, boundary },
  durableBusiness: { snapshot: conversation.snapshot, paymentUrl, leaseMs: 1500, boundary },
})
serve(
  { hostname: '127.0.0.1', port: 0, fetch: createApp({ system, modelAvailable: false }).fetch },
  (info) => {
    process.send?.({ url: `http://127.0.0.1:${info.port}` })
    system.conversations!.start()
    system.durableBusiness!.start()
  },
)
