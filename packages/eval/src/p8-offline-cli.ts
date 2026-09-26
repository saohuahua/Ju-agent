import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDatabase } from '../../persistence/src/db.js'
import { loadFixture } from '../../persistence/src/fixtures.js'
import { P8Investigation } from '../../runtime/src/p8-investigation.js'
import { p8FixtureInput, p8OfflineTransport } from './p8-offline-fixture.js'
import { p8Report } from './p8-offline-report.js'

const output = resolve(
  process.argv[2] ?? `docs/experiments/p8-offline-investigation-evidence/comparison-${Date.now()}`,
)
mkdirSync(output, { recursive: true })
const temporary = mkdtempSync(join(tmpdir(), 'p8-comparison-'))
const db = openDatabase(join(temporary, 'application.db'))
loadFixture(db)
const reports: ReturnType<typeof p8Report>[] = []
const protocol: unknown[] = []
try {
  for (const scenario of ['lost', 'not-lost', 'conflicting-records', 'missing-policy'] as const) {
    db.prepare("UPDATE orders SET status = ? WHERE order_no = 'SO-2026-0002'").run(
      scenario === 'conflicting-records' ? 'delivered' : 'shipped',
    )
    db.prepare("UPDATE shipments SET status = ? WHERE order_no = 'SO-2026-0002'").run(
      scenario === 'not-lost' ? 'in_transit' : 'lost',
    )
    if (scenario === 'missing-policy')
      db.prepare("DELETE FROM policy_articles WHERE article_id = 'R2_lost_package'").run()
    for (const mode of ['single', 'parallel'] as const) {
      const runtime = new P8Investigation(db, {
        transport: (_snapshot, role) => ({
          mode: 'simulation',
          async *stream(body, signal) {
            protocol.push({ scenario, mode, role, direction: 'request', body })
            for await (const frame of p8OfflineTransport(role, { delayMs: 50 }).stream(
              body,
              signal,
            )) {
              protocol.push({ scenario, mode, role, direction: 'response', frame })
              yield frame
            }
          },
        }),
      })
      const parent = runtime.accept(await p8FixtureInput(runtime, mode, scenario))
      await runtime.run(parent.taskId)
      reports.push(p8Report(runtime, parent.taskId))
    }
  }
  const pairs = [0, 2, 4, 6].map((index) => {
    const single = reports[index]!
    const parallel = reports[index + 1]!
    return {
      scenario: single.input.caseId,
      sameEvidence:
        JSON.stringify(single.input.evidence) === JSON.stringify(parallel.input.evidence),
      samePolicy:
        single.input.policyVersion === parallel.input.policyVersion &&
        single.input.knowledgeVersion === parallel.input.knowledgeVersion,
      compatible: single.conclusion?.recommendation === parallel.conclusion?.recommendation,
      single: single.metrics,
      parallel: parallel.metrics,
      recommendation: single.conclusion?.recommendation,
    }
  })
  if (pairs.some((pair) => !pair.sameEvidence || !pair.samePolicy || !pair.compatible))
    throw new Error('P8 对照配置或结论不兼容')
  await db.backup(join(output, 'application.db'))
  writeFileSync(
    join(output, 'report.json'),
    JSON.stringify(
      {
        description: '本机每个离线调用人为等待 50ms 的受控延迟实验 不代表真实质量成本或供应商性能',
        temporaryDatabase: temporary,
        pairs,
        reports,
        protocol,
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ output, pairs }, null, 2))
} finally {
  db.close()
}
