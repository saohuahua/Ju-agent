import { afterEach, expect, it } from 'vitest'
import { createMemoryDatabase, type SqliteDatabase } from '../../persistence/src/db.js'
import { loadFixture } from '../../persistence/src/fixtures.js'
import { startP6PaymentSimulator } from '../../persistence/src/p6-payment-simulator.js'
import { composeSystem } from '../src/compose.js'
import { conversationDemoOptions } from '../src/conversation-demo.js'
import { ScriptedModel } from '../../agent/src/scripted-model.js'
import { SystemClock } from '../../domain/src/clock.js'
import { P8Investigation } from '../src/p8-investigation.js'
import { p8FixtureInput, p8OfflineTransport } from '../../eval/src/p8-offline-fixture.js'
import { p8Report } from '../../eval/src/p8-offline-report.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function setup() {
  const db = createMemoryDatabase()
  cleanups.push(() => {
    db.close()
  })
  loadFixture(db)
  db.prepare("UPDATE shipments SET status = 'lost' WHERE order_no = 'SO-2026-0002'").run()
  const runtime = new P8Investigation(db, {
    transport: (_snapshot, role) => p8OfflineTransport(role),
  })
  return { db, runtime }
}

/** 通过原领域和持久 Worker 生成资金事实 不直接伪造退款未知状态 */
async function refund(db: SqliteDatabase, mode: 'normal' | 'unknown') {
  const channel = createMemoryDatabase()
  cleanups.push(() => {
    channel.close()
  })
  const server = await startP6PaymentSimulator(channel)
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())))
  const options = conversationDemoOptions(true)
  const system = composeSystem({
    db,
    withFixture: false,
    clock: new SystemClock(),
    model: new ScriptedModel([]),
    durableConversation: options,
    durableBusiness: {
      snapshot: options.snapshot,
      paymentUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    },
  })
  const task = system.conversations!.accept('C1001', 'p8-fix-refund', '丢件退款 SO-2026-0002')
  await system.conversations!.worker.runOnce()
  const link = db
    .prepare('SELECT return_no FROM p6_conversation_refunds WHERE run_id = ?')
    .get(task.runId) as { return_no: string }
  const key = `refund:${link.return_no}`
  channel.prepare('INSERT INTO p6_channel_faults VALUES (?,?)').run(key, mode)
  await system.durableBusiness!.runOnce()
  return { channel, key, returnNo: link.return_no }
}

it('真实 P6 未知资金进入 P8 记忆并保持人工核验和原发送许可', async () => {
  const { db, runtime } = setup()
  const payment = await refund(db, 'unknown')
  const ownership = db
    .prepare('SELECT * FROM execution_ownership WHERE business_key = ?')
    .get(payment.key)
  expect(
    db.prepare('SELECT status FROM refunds WHERE return_no = ?').get(payment.returnNo),
  ).toEqual({ status: 'executing' })
  const parent = runtime.accept(await p8FixtureInput(runtime))
  await runtime.run(parent.taskId)
  const result = p8Report(runtime, parent.taskId)
  expect(result.memory.unknownActions).toEqual([
    expect.objectContaining({
      kind: 'refund',
      status: 'executing',
      execution: expect.objectContaining({
        effectStatus: 'unknown',
        ownershipState: 'sending',
        taskStatus: 'needs_confirmation',
        bindingValid: true,
      }),
    }),
  ])
  expect(result.conclusion?.recommendation).toBe('human_review')
  expect(result.metrics.investigationComplete).toBe(false)
  expect(result.memory.completedActions).toEqual([])
  expect(
    db.prepare('SELECT * FROM execution_ownership WHERE business_key = ?').get(payment.key),
  ).toEqual(ownership)
  expect(payment.channel.prepare('SELECT submissions,charges FROM p6_channel').get()).toEqual({
    submissions: 1,
    charges: 0,
  })
})

it('已确认真实模拟退款保留成功事实 不误报为未知', async () => {
  const { db, runtime } = setup()
  const payment = await refund(db, 'normal')
  const parent = runtime.accept(await p8FixtureInput(runtime))
  await runtime.run(parent.taskId)
  const memory = runtime.repo.memory(parent.taskId)
  expect(memory.unknownActions).toEqual([])
  expect(memory.completedActions).toContainEqual(
    expect.objectContaining({ kind: 'refund', status: 'succeeded' }),
  )
  expect(payment.channel.prepare('SELECT submissions,charges FROM p6_channel').get()).toEqual({
    submissions: 1,
    charges: 1,
  })
})

it('旧执行器失败但许可未知仍须人工核验', async () => {
  const { db, runtime } = setup()
  const payment = await refund(db, 'unknown')
  // 构造旧执行器发生异常后的状态组合 验证不存在效果记录时仍读取原许可
  db.prepare('DELETE FROM p6_effects WHERE business_key = ?').run(payment.key)
  db.prepare("UPDATE refunds SET status = 'failed' WHERE return_no = ?").run(payment.returnNo)
  db.prepare(
    "UPDATE execution_ownership SET owner = 'legacy', holder = '', state = 'unknown' WHERE business_key = ?",
  ).run(payment.key)
  const parent = runtime.accept(await p8FixtureInput(runtime))
  await runtime.run(parent.taskId)
  const result = p8Report(runtime, parent.taskId)
  expect(result.memory.unknownActions).toContainEqual(
    expect.objectContaining({ kind: 'refund', status: 'failed' }),
  )
  expect(result.conclusion?.recommendation).toBe('human_review')
})

it('资金效果的任务归属被篡改时不归为已确认成功', async () => {
  const { db, runtime } = setup()
  const payment = await refund(db, 'normal')
  db.prepare(
    "UPDATE p6_tasks SET customer_id = 'C1002' WHERE task_id = (SELECT task_id FROM p6_effects WHERE business_key = ?)",
  ).run(payment.key)
  const parent = runtime.accept(await p8FixtureInput(runtime))
  await runtime.run(parent.taskId)
  const result = p8Report(runtime, parent.taskId)
  expect(result.memory.unknownActions).toContainEqual(
    expect.objectContaining({
      kind: 'refund',
      status: 'succeeded',
      execution: expect.objectContaining({ bindingValid: false }),
    }),
  )
  expect(result.memory.completedActions.some((item) => item.kind === 'refund')).toBe(false)
  expect(result.conclusion?.recommendation).toBe('human_review')
})

it.each(['queued', 'facts', 'completed'] as const)(
  '%s 原任务在源记录更新后同参重放仍返回原身份',
  async (phase) => {
    const { db, runtime } = setup()
    const input = await p8FixtureInput(runtime)
    const parent = runtime.accept(input)
    if (phase !== 'queued') await runtime.run(parent.taskId, phase === 'facts' ? 'facts' : 'all')
    const original = p8Report(runtime, parent.taskId)
    db.prepare("UPDATE orders SET version = version + 1 WHERE order_no = 'SO-2026-0002'").run()
    db.prepare("UPDATE shipments SET version = version + 1 WHERE order_no = 'SO-2026-0002'").run()
    db.prepare(
      "UPDATE policy_articles SET content = content || ' 新版本' WHERE article_id = 'R2_lost_package'",
    ).run()
    const resumed = new P8Investigation(db, {
      transport: (_snapshot, role) => p8OfflineTransport(role),
    })
    expect(resumed.accept({ ...structuredClone(input), acceptedAt: Date.now() }).taskId).toBe(
      parent.taskId,
    )
    expect(p8Report(resumed, parent.taskId)).toEqual(original)
    expect(() => resumed.accept({ ...input, userStatements: ['同键异参'] })).toThrow('身份内容冲突')
    expect(() => resumed.accept({ ...input, caseId: 'new-request' })).toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM p6_tasks').get()).toEqual({ n: 3 })
    await resumed.run(parent.taskId)
    expect(resumed.ledger.rows()).toHaveLength(2)
    expect(resumed.repo.input(parent.taskId)).toEqual(input)
  },
)
