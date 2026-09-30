import { serve } from '@hono/node-server'
import { ScriptedModel } from '@aftersales/agent'
import { FrozenClock, KeywordPolicyScorer } from '@aftersales/domain'
import { composeSystem } from '@aftersales/runtime'
import { createApp } from '../../src/app.js'

/** 独立内存夹具只使用模拟资金渠道 关闭服务即丢弃验收记录 */
const system = composeSystem({
  clock: new FrozenClock('2026-09-20T12:00:00Z'),
  model: new ScriptedModel([]),
  policyScorer: new KeywordPolicyScorer(),
})
const actor = { role: 'operator' as const }

for (const pending of [true, false]) {
  const run = await system.runService.start({
    customerId: 'C1001',
    model: 'ui-fixture',
    promptVersion: 'closure-test',
    source: 'sim',
  })
  await system.runService.emit(run.runId, 'message.user', {
    text: pending ? '结案验收 待执行补偿应阻止结案' : '结案验收 模拟补偿成功可结案',
  })
  await system.runService.transition(run.runId, 'running')
  await system.runService.transition(run.runId, 'escalated')
  await system.handoverService.takeOver(actor, run.runId)
  const record = await system.compensationService.createCompensation(
    actor,
    {
      orderNo: pending ? 'SO-2026-0003' : 'SO-2026-0011',
      reason: 'service_apology',
      amountCents: 100,
    },
    run.runId,
  )
  if (!pending)
    await system.compensationService.executeCompensation(
      actor,
      {
        compensationNo: record.compensationNo,
      },
      run.runId,
    )
}

serve({
  hostname: '127.0.0.1',
  port: 8787,
  fetch: createApp({ system, modelAvailable: false }).fetch,
})
