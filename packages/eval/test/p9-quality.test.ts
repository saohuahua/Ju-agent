import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryDatabase } from '@aftersales/persistence'
import { EvalReport, P7Error } from '@aftersales/contracts'
import { EVAL_CASES } from '../src/cases.js'
import { runBudgetedL1, saveP7EvalEvidence, readP7EvalEvidence } from '../src/p7-suite-entry.js'
import { offlineEvalRoles } from '../src/p7-offline-roles.js'
import {
  exportQualityBundle,
  compareQualityBundles,
  verifyQualityBundle,
  failureClasses,
} from '../src/p9-report.js'
import { contentHash, sourceIdentity } from '../src/p9-metadata.js'
import { redactEvidence } from '../src/p9-evidence.js'
import { buildReport } from '../src/report.js'
import { calibrationSummary, type CalibrationLabel } from '../src/p9-calibration.js'
import { createP7Snapshot } from '@aftersales/runtime'
import { runSimSuite } from '../src/sim-suite.js'
import { P7Ledger } from '@aftersales/persistence'

const databases: ReturnType<typeof createMemoryDatabase>[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
function db() {
  const value = createMemoryDatabase()
  databases.push(value)
  return value
}
const sample = EVAL_CASES.find((item) => item.id === 'hp_query_order_status')!
function directory() {
  return mkdtempSync(join(tmpdir(), 'p9-quality-'))
}

// 同一共享账本中的两个预先声明实验只改变受控故障
it('两轮原始证据可解析 次轮失败不被首轮掩盖 费用保留未知', async () => {
  const ledger = db()
  const normal = await runBudgetedL1([sample], 2, {
    db: ledger,
    experimentId: 'normal',
    roles: offlineEvalRoles,
  })
  const fault = await runBudgetedL1([sample], 2, {
    db: ledger,
    experimentId: 'fault',
    roles: (item, repeat) => {
      const roles = offlineEvalRoles(item)
      if (repeat === 2)
        roles.main_agent.transport = {
          mode: 'simulation',
          stream() {
            throw new P7Error('PROTOCOL')
          },
        }
      return roles
    },
  })
  expect(normal.report.passed).toBe(2)
  expect(fault.report.total).toBe(2)
  expect(fault.report.failed).toBe(1)
  expect(fault.report.gatePassed).toBe(false)
  expect(fault.report.caseResults.map((item) => item.repeat)).toEqual([1, 2])
  const left = directory()
  const right = directory()
  exportQualityBundle(left, normal)
  exportQualityBundle(right, fault, 'protocol-repeat-2')
  const resolved = verifyQualityBundle(right)
  expect(resolved.cases[0]!.business!.runs[0]!.run_id).toBe(fault.evidence.cases[0]!.businessRunId)
  expect(resolved.cases[0]!.business!.events.length).toBeGreaterThan(0)
  expect(resolved.cases[0]!.modelCalls![0]!.request).toBeTruthy()
  expect(resolved.cases[0]!.modelCalls![0]!.events.length).toBeGreaterThan(0)
  expect(compareQualityBundles(left, right).comparable).toBe(false)
  const comparison = compareQualityBundles(left, right, ['fault'])
  expect(comparison.comparable).toBe(true)
  expect(comparison.differences?.newFailures).toEqual([JSON.stringify([sample.id, 2])])
  expect(comparison.differences?.simulationCost.actualTotalDelta).toBeNull()
  expect(comparison.differences?.simulationCost.after.unknown.count).toBeGreaterThan(0)
  expect(compareQualityBundles(right, left, ['fault']).differences?.fixedFailures).toHaveLength(1)
  expect(compareQualityBundles(right, right).differences?.persistentFailures).toHaveLength(1)
  saveP7EvalEvidence(ledger, fault)
  expect(readP7EvalEvidence(ledger, fault.report.reportId)).toEqual(fault.evidence)
})

it('旧报告格式读取兼容 缺少元数据不得凭旧分母比较', async () => {
  const result = await runBudgetedL1([sample], 1, {
    db: db(),
    experimentId: 'legacy',
    roles: offlineEvalRoles,
  })
  const old = structuredClone(result.report)
  delete old.metricVersion
  old.caseResults.forEach((item) => {
    delete item.repeat
  })
  expect(EvalReport.parse(old).total).toBe(1)
  delete result.evidence.metadata
  expect(() => exportQualityBundle(directory(), result)).toThrow('元数据')
})

it('版本或样本变化拒绝比较 不输出提升差值', async () => {
  const result = await runBudgetedL1([sample], 1, {
    db: db(),
    experimentId: 'compare',
    roles: offlineEvalRoles,
  })
  const left = directory()
  const right = directory()
  exportQualityBundle(left, result)
  result.evidence.metadata!.knowledgeHash = 'other-policy-corpus'
  exportQualityBundle(right, result)
  expect(compareQualityBundles(left, right)).toMatchObject({ comparable: false, differences: null })
  expect(() =>
    buildReport({
      cases: [sample],
      rounds: [[], []],
      repeat: 2,
      model: 'offline',
      promptVersion: 'v1',
      roundDurationsMs: [0, 0],
    }),
  ).toThrow('分母')
})

it('缺失重复篡改及错配证据均拒绝', async () => {
  const result = await runBudgetedL1([sample], 1, {
    db: db(),
    experimentId: 'integrity',
    roles: offlineEvalRoles,
  })
  for (const mutation of [
    'missing',
    'duplicate',
    'tampered',
    'wrong-run',
    'duplicate-event',
    'missing-call',
  ]) {
    const dir = directory()
    const bundle = exportQualityBundle(dir, result)
    if (mutation === 'missing') bundle.references = []
    if (mutation === 'duplicate') bundle.references.push(bundle.references[0]!)
    if (['tampered', 'wrong-run', 'duplicate-event', 'missing-call'].includes(mutation)) {
      const file = join(dir, bundle.references[0]!.file)
      const item = JSON.parse(readFileSync(file, 'utf8')) as (typeof result.evidence.cases)[number]
      if (mutation === 'tampered') item.passed = false
      if (mutation === 'wrong-run') item.business!.runs[0]!.run_id = 'unrelated'
      if (mutation === 'duplicate-event') item.business!.events.push(item.business!.events[0]!)
      if (mutation === 'missing-call') item.modelCalls = []
      writeFileSync(file, JSON.stringify(item))
      if (mutation !== 'tampered') bundle.references[0]!.hash = contentHash(item)
    }
    writeFileSync(join(dir, 'quality.json'), JSON.stringify(bundle))
    expect(() => verifyQualityBundle(dir), mutation).toThrow()
  }
})

it.each(['PROTOCOL', 'TIMEOUT', 'UPSTREAM', 'BUDGET_EXCEEDED'] as const)(
  '模型故障 %s 留在端到端分母并明确分类',
  async (code) => {
    const result = await runBudgetedL1([sample], 1, {
      db: db(),
      experimentId: code,
      roles: (item) => {
        const roles = offlineEvalRoles(item)
        roles.main_agent.transport = {
          mode: 'simulation',
          stream() {
            throw new P7Error(code)
          },
        }
        return roles
      },
    })
    const expected = {
      PROTOCOL: 'model_protocol',
      TIMEOUT: 'timeout_cancel',
      UPSTREAM: 'service_exception',
      BUDGET_EXCEEDED: 'budget_blocked',
    }
    expect(result.report.total).toBe(1)
    expect(result.report.failed).toBe(1)
    expect(failureClasses(result.evidence.cases[0]!)).toContain(expected[code])
  },
)

it('服务装配失败和缺失证据保留分母', async () => {
  const result = await runBudgetedL1([sample], 2, {
    db: db(),
    experimentId: 'setup',
    roles() {
      throw new Error('controlled')
    },
  })
  expect(result.report).toMatchObject({ total: 2, passed: 0, failed: 2, gatePassed: false })
  expect(result.evidence.cases[0]!.modelRunIds).toEqual({})
  expect(failureClasses(result.evidence.cases[0]!)).toEqual(
    expect.arrayContaining(['service_exception', 'evidence_missing']),
  )
  expect(result.evidence.costs.selection.summary.observation).toBe('no_recorded_calls')
  exportQualityBundle(directory(), result)
})

it('真实预算预检查阻断无账本行且原占用不清零', async () => {
  const ledger = db()
  const first = await runBudgetedL1([sample], 1, {
    db: ledger,
    experimentId: 'budget-first',
    roles: (item) => {
      const roles = offlineEvalRoles(item)
      const { version: _version, ...base } = roles.main_agent.snapshot
      roles.main_agent.snapshot = createP7Snapshot({
        ...base,
        price: { ...base.price!, fixedMicroPerCall: 60000000 },
      })
      return roles
    },
  })
  const before = first.evidence.costs.scopeSummary.committed
  const result = await runBudgetedL1([sample], 1, {
    db: ledger,
    experimentId: 'budget-next',
    roles: (item) => {
      const roles = offlineEvalRoles(item)
      const { version: _version, ...base } = roles.main_agent.snapshot
      roles.main_agent.snapshot = createP7Snapshot({
        ...base,
        price: { ...base.price!, fixedMicroPerCall: 60000000 },
      })
      return roles
    },
  })
  expect(result.evidence.costs.scopeSummary.committed).toBe(before)
  expect(result.evidence.costs.selection.summary.observation).toBe('no_recorded_calls')
  expect(failureClasses(result.evidence.cases[0]!)).toContain('budget_blocked')
  exportQualityBundle(directory(), result)
})

it('元数据内容清单可复核且不收集环境文件', () => {
  const source = sourceIdentity()
  expect(source.hash).toBe(contentHash(source.files))
  expect(source.files.some((item) => /\.env|node_modules|docs\/experiments/.test(item.path))).toBe(
    false,
  )
  expect(source.dirty).toBe(true)
  expect(source.files.some((item) => item.path === 'packages/eval/src/judge.ts')).toBe(true)
})

it('嵌套 JSON 凭据与内部发送令牌及文本回显过滤', () => {
  const value = redactEvidence({
    token: 'secret-value',
    args_json: '{"sendToken":"send-secret"}',
    text: 'secret-value send-secret Bearer abc',
    usage: { inputTokens: 10 },
  })
  expect(JSON.stringify(value)).not.toMatch(/secret-value|send-secret|Bearer abc/)
  expect(value.usage.inputTokens).toBe(10)
})

it('合成校准夹具不冒充真实人工一致率', () => {
  expect(calibrationSummary([])).toMatchObject({ status: 'not_calibrated', agreement: null })
  const labels: CalibrationLabel[] = [true, false].map((passed, index) => ({
    schemaVersion: 1,
    source: 'synthetic',
    rubricVersion: 'synthetic-v1',
    experimentId: 'synthetic',
    caseId: `case-${index}`,
    repeat: 1,
    rubric: '礼貌',
    evidenceHash: 'synthetic-evidence',
    annotator: 'synthetic-fixture',
    humanPassed: passed,
    judgePassed: true,
  }))
  expect(calibrationSummary(labels)).toMatchObject({
    status: 'synthetic_algorithm_check_only',
    agreement: 0.5,
    falsePasses: 1,
  })
  expect(() => calibrationSummary([labels[0]!, labels[0]!])).toThrow()
})

it('Judge 失败不覆盖确定性业务成功 原始 Judge 输出可追溯', async () => {
  const result = await runSimSuite({
    repeat: 1,
    sample: 'all',
    caseId: sample.id,
    agentModel: 'offline',
    userModel: 'offline',
    judgeModel: 'offline',
    budget: { db: db(), experimentId: 'judge-boundary', roles: offlineEvalRoles },
  })
  const dir = directory()
  const bundle = exportQualityBundle(dir, result)
  expect(bundle.summary.endToEnd).toEqual({ passed: 0, total: 1 })
  expect(bundle.summary.business).toEqual({ passed: 1, total: 1, scorable: 1 })
  expect(bundle.summary.subjective).toEqual({ passed: 0, total: 1 })
  expect(bundle.report.metrics.task_success_rate).toBe(1)
  expect(bundle.report.metrics.side_effect_correctness).toBe(1)
  expect(
    verifyQualityBundle(dir).cases[0]!.modelCalls!.some(
      (call) => JSON.parse(call.runId)[4] === 'judge' && call.events.length > 0,
    ),
  ).toBe(true)
})

it('配置模型变量必须声明 其余运行配置不能夹带变化', async () => {
  const normal = await runBudgetedL1([sample], 1, {
    db: db(),
    experimentId: 'model-a',
    roles: offlineEvalRoles,
  })
  const changed = await runBudgetedL1([sample], 1, {
    db: db(),
    experimentId: 'model-b',
    roles: (item) => {
      const roles = offlineEvalRoles(item)
      const { version: _version, ...base } = roles.main_agent.snapshot
      roles.main_agent.snapshot = createP7Snapshot({
        ...base,
        model: 'offline-declared-alternative',
      })
      return roles
    },
  })
  const left = directory()
  const right = directory()
  exportQualityBundle(left, normal)
  exportQualityBundle(right, changed)
  expect(compareQualityBundles(left, right).comparable).toBe(false)
  expect(compareQualityBundles(left, right, ['model']).comparable).toBe(true)
  const config = changed.evidence.cases[0]!.configurations!.main_agent as Record<string, unknown>
  config.timeoutMs = 100
  exportQualityBundle(right, changed)
  expect(compareQualityBundles(left, right, ['model']).comparable).toBe(false)
})

it('共享账本已有 held 导出与比较均保留且不修改账本', async () => {
  const ledgerDb = db()
  const ledger = new P7Ledger(ledgerDb)
  ledger.reserve(
    {
      callId: 'prior-held',
      operationId: 'prior-operation',
      runId: 'legacy-run',
      purpose: 'main_agent',
      attempt: 1,
    },
    offlineEvalRoles(sample).main_agent.snapshot,
    10,
  )
  const result = await runBudgetedL1([sample], 1, {
    db: ledgerDb,
    experimentId: 'with-held',
    roles: offlineEvalRoles,
  })
  const before = ledgerDb.prepare('SELECT * FROM p7_calls').all()
  const dir = directory()
  const bundle = exportQualityBundle(dir, result)
  expect(bundle.costs.scopeSummary.held).toEqual({ reserved: 10, count: 1 })
  expect(bundle.costs.calls.find((call) => call.callId === 'prior-held')?.actual).toBeNull()
  expect(compareQualityBundles(dir, dir).comparable).toBe(true)
  expect(ledgerDb.prepare('SELECT * FROM p7_calls').all()).toEqual(before)
})
