import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryDatabase, P7Ledger } from '@aftersales/persistence'
import { P7Error } from '@aftersales/contracts'
import { EVAL_CASES } from '../src/cases.js'
import { offlineEvalRoles } from '../src/p7-offline-roles.js'
import { runBudgetedL1, suiteModels } from '../src/p7-suite-entry.js'
import { judgeTranscript } from '../src/judge.js'
import { buildReport } from '../src/report.js'
import { wilson95 } from '../src/metrics.js'
import { exportQualityBundle, verifyQualityBundle } from '../src/p9-report.js'

const databases: ReturnType<typeof createMemoryDatabase>[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
const sample = EVAL_CASES.find((item) => item.id === 'hp_query_order_status')!
function database() {
  const db = createMemoryDatabase()
  databases.push(db)
  return db
}

it('Judge 超时返回前完成取消并冻结原网关观察 保留未知费用占位且不取消其他角色', async () => {
  const db = database()
  const ledger = new P7Ledger(db)
  let release: () => void = () => undefined
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let transportSignal: AbortSignal | undefined
  const models = suiteModels(
    {
      db,
      experimentId: 'timeout-fix',
      roles(testCase) {
        const roles = offlineEvalRoles(testCase)
        const original = roles.judge.transport
        roles.judge.transport = {
          mode: 'simulation',
          async *stream(body, signal) {
            transportSignal = signal
            // 故意延迟响应取消 验证网关阻止迟到结果重新结算
            await pending
            yield* original.stream(body, signal)
          },
        }
        return roles
      },
    },
    sample,
    1,
    ledger,
  )
  try {
    expect(
      await judgeTranscript({ model: models.judgeModel, timeoutMs: 10 }, ['礼貌'], []),
    ).toEqual([{ rubric: 'judge 超时', reason: '未获得完整判定' }])
    expect(transportSignal?.aborted).toBe(true)
    expect(ledger.totals().active).toBe(1)
    expect(ledger.rows()).toHaveLength(1)
    expect(ledger.rows()[0]).toMatchObject({
      status: 'unknown',
      actual: null,
      outcome: 'CANCELLED',
    })
    const snapshot = JSON.stringify({ rows: ledger.rows(), observations: models.observations })
    release()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(JSON.stringify({ rows: ledger.rows(), observations: models.observations })).toBe(
      snapshot,
    )
    for await (const _event of models.userModel.stream({ system: '', messages: [], tools: [] })) {
      /* 消费完整协议 */
    }
    expect(ledger.rows()).toHaveLength(2)
    expect(ledger.totals().active).toBe(1)
  } finally {
    release()
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
})

it('业务成功率区间和点估计共用分子 不受单独 Judge 失败影响', () => {
  const report = buildReport({
    cases: [sample],
    repeat: 1,
    level: 'L2',
    model: 'offline',
    promptVersion: 'test',
    roundDurationsMs: [0],
    rounds: [
      [
        {
          caseId: sample.id,
          category: sample.category,
          priority: sample.priority,
          passed: false,
          durationMs: 0,
          failures: [{ kind: 'judge', message: '主观项失败' }],
          layer: {
            stateOk: true,
            trajectoryOk: true,
            argsOk: true,
            escalationOk: true,
            clarifyOk: true,
            gatewayOk: true,
          },
        },
      ],
    ],
  })
  expect(report.metrics.task_success_rate).toBe(1)
  expect(report.passed).toBe(0)
  expect(report.confidenceIntervals?.task_success_rate).toEqual(wilson95(1, 1))
})

it.each(['reference-pass', 'reference-class', 'missing', 'empty', 'duplicate', 'extra'])(
  '拒绝损坏的失败索引 %s',
  async (mutation) => {
    const result = await runBudgetedL1([sample], 1, {
      db: database(),
      experimentId: `index-${mutation}`,
      roles(testCase) {
        const roles = offlineEvalRoles(testCase)
        roles.main_agent.transport = {
          mode: 'simulation',
          stream() {
            throw new P7Error('PROTOCOL')
          },
        }
        return roles
      },
    })
    const directory = mkdtempSync(join(tmpdir(), 'p9-index-fix-'))
    const bundle = exportQualityBundle(directory, result)
    const path = join(directory, 'failures.json')
    const failures = JSON.parse(readFileSync(path, 'utf8'))
    if (mutation === 'reference-pass') bundle.references[0]!.passed = true
    if (mutation === 'reference-class') bundle.references[0]!.classes = []
    if (mutation === 'missing') unlinkSync(path)
    if (mutation === 'empty') writeFileSync(path, '[]')
    if (mutation === 'duplicate') writeFileSync(path, JSON.stringify([...failures, failures[0]]))
    if (mutation === 'extra')
      writeFileSync(path, JSON.stringify([...failures, { ...failures[0], key: 'foreign' }]))
    writeFileSync(join(directory, 'quality.json'), JSON.stringify(bundle))
    expect(() => verifyQualityBundle(directory)).toThrow()
  },
)
