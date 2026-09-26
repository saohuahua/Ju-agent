import { openDatabase } from '../../../persistence/src/db.js'
import { loadFixture } from '../../../persistence/src/fixtures.js'
import { P8Investigation } from '../../src/p8-investigation.js'
import { p8FixtureInput, p8OfflineTransport } from '../../../eval/src/p8-offline-fixture.js'
import { p8Report } from '../../../eval/src/p8-offline-report.js'

const [path, phase] = process.argv.slice(2)
if (!path || !phase) throw new Error('缺少 P8 进程实验参数')
const db = openDatabase(path)
const runtime = new P8Investigation(db, {
  transport: (_snapshot, role) => p8OfflineTransport(role),
  leaseMs: 60,
  boundary: async (name, task) => {
    if (
      phase === 'model-unconfirmed' &&
      name === 'after-model-response' &&
      task.tool === 'p8-facts'
    ) {
      process.exit(71)
    }
  },
})
let row = db.prepare('SELECT parent_task_id AS id FROM p8_investigations LIMIT 1').get() as
  { id: string } | undefined
if (!row) {
  loadFixture(db)
  db.prepare("UPDATE shipments SET status = 'lost' WHERE order_no = 'SO-2026-0002'").run()
  row = { id: runtime.accept(await p8FixtureInput(runtime)).taskId }
}
if (phase === 'accepted') process.exit(71)
if (phase === 'one-confirmed') {
  await runtime.run(row.id, 'facts')
  process.exit(71)
}
if (phase === 'both-confirmed') {
  await runtime.run(row.id, 'branches')
  process.exit(71)
}
if (phase === 'model-unconfirmed') await runtime.run(row.id, 'facts')
await runtime.run(row.id)
console.log(JSON.stringify(p8Report(runtime, row.id)))
db.close()
