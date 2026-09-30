import { writeFileSync } from 'node:fs'
import { createMemoryDatabase, loadFixture, startP6PaymentSimulator } from '../../../packages/persistence/src/index.js'
import { composeSystem } from '../../../packages/runtime/src/compose.js'
import { conversationDemoOptions } from '../../../packages/runtime/src/conversation-demo.js'
import { ScriptedModel } from '../../../packages/agent/src/scripted-model.js'
import { SystemClock } from '../../../packages/domain/src/clock.js'
import { P8Investigation } from '../../../packages/runtime/src/p8-investigation.js'
import { p8FixtureInput, p8OfflineTransport } from '../../../packages/eval/src/p8-offline-fixture.js'
import { p8Report } from '../../../packages/eval/src/p8-offline-report.js'

// 验收探针通过现有退款流程产生真实模拟未知状态 不修改生产代码
const db = createMemoryDatabase()
const channel = createMemoryDatabase()
const server = await startP6PaymentSimulator(channel)
try {
  loadFixture(db)
  db.prepare("UPDATE shipments SET status = 'lost' WHERE order_no = 'SO-2026-0002'").run()
  const options = conversationDemoOptions(true)
  const system = composeSystem({ db, withFixture: false, clock: new SystemClock(), model: new ScriptedModel([]), durableConversation: options, durableBusiness: { snapshot: options.snapshot, paymentUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` } })
  const task = system.conversations!.accept('C1001','acceptance-unknown','丢件退款 SO-2026-0002')
  await system.conversations!.worker.runOnce()
  const link = db.prepare('SELECT return_no FROM p6_conversation_refunds WHERE run_id = ?').get(task.runId) as { return_no: string }
  channel.prepare("INSERT INTO p6_channel_faults VALUES (?,'unknown')").run(`refund:${link.return_no}`)
  await system.durableBusiness!.runOnce()
  const runtime = new P8Investigation(db,{transport:(_snapshot,role)=>p8OfflineTransport(role)})
  const input = await p8FixtureInput(runtime,'parallel','actual-p6-unknown')
  const parent = runtime.accept(input)
  await runtime.run(parent.taskId)
  const report = p8Report(runtime,parent.taskId)
  const result = {
    refund: db.prepare('SELECT refund_no,status FROM refunds WHERE return_no = ?').get(link.return_no),
    effect: db.prepare('SELECT status FROM p6_effects WHERE business_key = ?').get(`refund:${link.return_no}`),
    ownership: db.prepare('SELECT owner,state FROM execution_ownership WHERE business_key = ?').get(`refund:${link.return_no}`),
    businessTask: db.prepare("SELECT status FROM p6_tasks WHERE run_id = ? AND tool = 'return_request'").get(task.runId),
    channel: channel.prepare('SELECT status,submissions,charges FROM p6_channel').all(),
    memory: report.memory,
    recommendation: report.conclusion?.recommendation,
    investigationComplete: report.metrics.investigationComplete,
  }
  writeFileSync(new URL('./unknown-business-reproduction.json',import.meta.url),JSON.stringify(result,null,2))
  console.log(JSON.stringify({ ...result, memory: { businessReferences: result.memory.businessReferences, unknownActions: result.memory.unknownActions } },null,2))
  // 原请求已经完成后源记录变化 不应使同一受理身份失去原任务
  db.prepare("UPDATE orders SET version = version + 1 WHERE order_no = 'SO-2026-0002'").run()
  let replay: { returnedTaskId?: string; error?: string }
  try { replay = { returnedTaskId: runtime.accept(input).taskId } }
  catch (error) { replay = { error: error instanceof Error ? error.message : String(error) } }
  const replayResult = { originalTaskId: parent.taskId, originalStatus: runtime.repo.tasks.get(parent.taskId)?.status, sameOriginalInput: true, replay }
  writeFileSync(new URL('./idempotent-replay-reproduction.json',import.meta.url),JSON.stringify(replayResult,null,2))
  console.log(JSON.stringify(replayResult,null,2))
} finally {
  await new Promise<void>(done=>server.close(()=>done()))
  db.close()
  channel.close()
}
