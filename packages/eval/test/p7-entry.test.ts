import { afterEach, expect, it } from 'vitest'
import { createMemoryDatabase, clearBusinessData } from '@aftersales/persistence'
import { createP7Snapshot } from '@aftersales/runtime'
import { EVAL_CASES } from '../src/cases.js'
import { runBudgetedL1, saveP7EvalEvidence, readP7EvalEvidence } from '../src/p7-suite-entry.js'
import { offlineEvalRoles } from '../src/p7-offline-roles.js'
import { runSimSuite } from '../src/sim-suite.js'
import { roleConfig, offline } from './fixtures/p7-eval-fixtures.js'

const databases: ReturnType<typeof createMemoryDatabase>[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
function database() {
  const db = createMemoryDatabase()
  databases.push(db)
  return db
}
const testCase = EVAL_CASES.find((item) => item.id === 'hp_query_order_status')!
const options = {
  repeat: 1,
  sample: 'p0' as const,
  caseId: testCase.id,
  agentModel: 'offline-main_agent',
  userModel: 'offline-simulator',
  judgeModel: 'offline-judge',
}

it('正式 L1 工厂按重复轮次归因并保存业务关联 清库保留费用及附件', async () => {
  const db = database()
  const result = await runBudgetedL1([testCase], 2, {
    db,
    experimentId: 'l1-entry',
    roles: offlineEvalRoles,
  })
  expect(result.report.gatePassed).toBe(true)
  expect(result.evidence.cases.map((item) => item.identity.repeat)).toEqual([1, 2])
  expect(result.evidence.cases.every((item) => item.businessRunId)).toBe(true)
  expect(result.evidence.costs.selection.summary.attempts).toBeGreaterThan(0)
  expect(result.evidence.costs.calls.every((item) => item.attribution.kind === 'eval')).toBe(true)
  expect(result.report.caseResults[0]?.agentCostUsd).toBeUndefined()
  saveP7EvalEvidence(db, result)
  clearBusinessData(db)
  expect(readP7EvalEvidence(db, result.report.reportId)).toEqual(result.evidence)
  expect(db.prepare('SELECT count(*) AS n FROM p7_calls').get()).toEqual({
    n: result.evidence.costs.scopeSummary.attempts,
  })
})

it('正式 L2 入口经过真实模拟器与主循环 同身份重放不新增传输', async () => {
  const db = database()
  const budget = { db, experimentId: 'l2-entry', roles: offlineEvalRoles }
  const first = await runSimSuite({ ...options, budget })
  expect(first.evidence.costs.calls.some((item) => item.purpose === 'main_agent')).toBe(true)
  expect(first.evidence.costs.calls.some((item) => item.purpose === 'simulator')).toBe(true)
  const second = await runSimSuite({ ...options, budget })
  expect(second.report.gatePassed).toBe(false)
  expect(second.evidence.costs.scopeSummary.attempts).toBe(
    first.evidence.costs.scopeSummary.attempts,
  )
  expect(second.evidence.cases[0]?.failures.length).toBeGreaterThan(0)
})

it('模型失败只由网关重试 套件不增加重复轮次绕过预算', async () => {
  const db = database()
  let transfers = 0
  const result = await runSimSuite({
    ...options,
    budget: {
      db,
      experimentId: 'retry-entry',
      roles: (item) => {
        const roles = offlineEvalRoles(item)
        roles.main_agent = roleConfig(
          'main_agent',
          {
            mode: 'simulation',
            stream() {
              transfers++
              throw Object.assign(new Error('rate limited'), { status: 429 })
            },
          },
          10,
          { maxAttempts: 2 },
        )
        return roles
      },
    },
  })
  expect(transfers).toBe(2)
  expect(
    result.evidence.costs.calls
      .filter((item) => item.purpose === 'main_agent')
      .map((item) => item.attempt)
      .sort(),
  ).toEqual([1, 2])
  expect(result.evidence.costs.scopeSummary.unknown.count).toBe(2)
  expect(
    result.evidence.cases[0]?.failures.some((item) => item.message.includes('RATE_LIMITED')),
  ).toBe(true)
})

it('先前实验费用阻断后续入口 保留零行拒绝证据', async () => {
  const db = database()
  const first = await runBudgetedL1([testCase], 1, {
    db,
    experimentId: 'exp-a',
    roles: (item) => {
      const roles = offlineEvalRoles(item)
      const { version: _version, ...snapshot } = roles.main_agent.snapshot
      roles.main_agent.snapshot = createP7Snapshot({
        ...snapshot,
        price: { ...snapshot.price!, fixedMicroPerCall: 60000000 },
      })
      return roles
    },
  })
  const count = first.evidence.costs.scopeSummary.attempts
  const source = offline()
  const role = roleConfig('simulator', source.transport, 60000000)
  const second = await runSimSuite({
    ...options,
    budget: {
      db,
      experimentId: 'exp-b',
      roles: (item) => ({ ...offlineEvalRoles(item), simulator: role }),
    },
  })
  expect(source.calls).toHaveLength(0)
  expect(second.evidence.costs.scopeSummary.attempts).toBe(count)
  expect(second.evidence.costs.selection.summary.attempts).toBe(0)
  expect(
    second.evidence.cases[0]?.failures.some((item) => item.message.includes('BUDGET_EXCEEDED')),
  ).toBe(true)
})

it('调用前取消不创建账本记录', async () => {
  const db = database()
  const controller = new AbortController()
  controller.abort()
  await expect(
    runSimSuite({
      ...options,
      budget: { db, experimentId: 'cancelled', roles: offlineEvalRoles, signal: controller.signal },
    }),
  ).rejects.toThrow()
  expect(db.prepare('SELECT count(*) AS n FROM p7_calls').get()).toEqual({ n: 0 })
})

it.each([
  'rec_crash_during_verification',
  'lg_pending_approval_queued',
  'sec_cross_customer_order',
])('%s 正式预算回放保留领域断言并符合工具结果配对', async (id) => {
  const result = await runBudgetedL1([EVAL_CASES.find((item) => item.id === id)!], 1, {
    db: database(),
    experimentId: id,
    roles: offlineEvalRoles,
  })
  expect(result.report.caseResults[0]?.failures).toEqual([])
  expect(result.report.passed).toBe(1)
})
