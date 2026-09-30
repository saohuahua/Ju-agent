import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryDatabase, type SqliteDatabase } from '../../persistence/src/db.js'
import { P7Ledger } from '../../persistence/src/p7-ledger.js'
import { P7Error } from '../../contracts/src/p7-model-gateway.js'
import { P7Gateway, type P7Transport } from '../../runtime/src/p7-gateway.js'
import { frames, streamFrames } from '../../runtime/test/p7-fixtures.js'
import { createP7EvalModels } from '../src/p7-eval-models.js'
import { readP7CostReport } from '../src/p7-cost-report.js'
import { UserSimulator } from '../src/simulator.js'
import { judgeTranscript } from '../src/judge.js'
import {
  consume,
  offline,
  pendingTransport,
  roleConfig,
  scenario,
} from './fixtures/p7-eval-fixtures.js'

const scope = 'simulation:first-real-cny-100'
const databases: SqliteDatabase[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

/** 独立内存账本复用既有离线协议夹具 */
function setup() {
  const db = createMemoryDatabase()
  databases.push(db)
  const ledger = new P7Ledger(db)
  const transport = offline()
  const roles = {
    main_agent: roleConfig('main_agent', transport.transport),
    simulator: roleConfig('simulator', transport.transport),
    judge: roleConfig('judge', transport.transport),
  }
  const identity = { experimentId: 'exp-1', caseId: 'case-1', repeat: 1 }
  return { db, ledger, transport, roles, identity }
}

/** 比较全量原始记录以证明投影没有释放或修改预算 */
function stored(db: SqliteDatabase) {
  return ['p7_budgets', 'p7_calls', 'p7_run_snapshots'].map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  )
}

describe('P7 只读费用报告', () => {
  it('真实三角色连续轮次及用例重复身份精确归因且美元字段不变', async () => {
    const s = setup()
    const judge = offline('openai_chat', '[]')
    s.roles.judge = roleConfig('judge', judge.transport)
    const models = createP7EvalModels(s)
    const user = new UserSimulator({ model: models.userModel, scenario })
    await user.openingMessage()
    await user.replyTo('请提供订单号')
    const events = await consume(models.agentModel)
    await judgeTranscript({ model: models.judgeModel }, ['礼貌'], [])
    for (const identity of [
      { ...s.identity, caseId: 'case-2' },
      { ...s.identity, repeat: 2 },
      { ...s.identity, experimentId: 'exp-10' },
    ])
      await consume(createP7EvalModels({ ...s, identity }).agentModel)
    const before = stored(s.db)
    const eventBefore = JSON.stringify(events)
    const report = readP7CostReport(s.db, { scope, experimentId: 'exp-1' })
    expect(report.scopeSummary).toMatchObject({ attempts: 7, logicalCalls: 7, committed: 70 })
    expect(report.selection.summary).toMatchObject({ attempts: 6, committed: 60 })
    expect(report.budget.remaining).toBe(100_000_000 - 70)
    expect(
      report.calls
        .filter((c) => c.attribution.identity?.role === 'simulator')
        .map((c) => c.attribution.callRound)
        .sort(),
    ).toEqual([1, 2])
    expect(report.calls.map((c) => c.attribution.identity)).toEqual(
      expect.arrayContaining([
        { ...s.identity, role: 'main_agent' },
        { ...s.identity, role: 'judge' },
        { ...s.identity, caseId: 'case-2', role: 'main_agent' },
        { ...s.identity, repeat: 2, role: 'main_agent' },
      ]),
    )
    expect(s.transport.calls.length + judge.calls.length).toBe(7)
    expect(s.ledger.rows()).toHaveLength(7)
    expect(stored(s.db)).toEqual(before)
    expect(JSON.stringify(events)).toBe(eventBefore)
    expect(events.at(-1)).toMatchObject({ usage: { costUsd: null } })
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
    const serialized = JSON.stringify(report)
    for (const field of [
      'credentialRef',
      'endpointRef',
      'price_json',
      'snapshot_json',
      'costUsd',
      '离线评测',
      'messages',
    ])
      expect(serialized).not.toContain(field)
  })

  it('真实网关重试各尝试计费但逻辑调用只计一次', async () => {
    const s = setup()
    let transmissions = 0
    s.roles.main_agent = roleConfig(
      'main_agent',
      {
        mode: 'simulation',
        stream() {
          if (++transmissions === 1) throw new P7Error('RATE_LIMITED')
          return streamFrames(frames('openai_chat'))
        },
      },
      10,
      { maxAttempts: 2 },
    )
    await consume(createP7EvalModels(s).agentModel)
    const report = readP7CostReport(s.db, { scope })
    expect(transmissions).toBe(2)
    expect(s.ledger.rows()).toHaveLength(2)
    expect(report.scopeSummary).toMatchObject({
      attempts: 2,
      logicalCalls: 1,
      settled: { actual: 10, count: 1 },
      unknown: { reserved: 10, count: 1 },
      committed: 20,
      hasUncertainCost: true,
    })
    expect(new Set(report.calls.map((c) => c.operationId)).size).toBe(1)
    expect(report.calls.map((c) => c.attempt).sort()).toEqual([1, 2])
  })

  it('屏障内同时观察 settled unknown held 且只执行一条只读 SQL', async () => {
    const s = setup()
    await consume(createP7EvalModels(s).agentModel)
    const unknown = new P7Gateway(s.roles.main_agent.snapshot, s.ledger)
    await unknown.invoke({ runId: 'legacy', purpose: 'embedding' }, async () => 'no usage')
    const pending = pendingTransport()
    s.roles.simulator = roleConfig('simulator', pending.transport, 30)
    const result = consume(createP7EvalModels(s).userModel)
    await pending.ready
    try {
      const before = stored(s.db)
      const statements: string[] = []
      const original = s.db.prepare.bind(s.db)
      s.db.prepare = ((sql: string) => {
        statements.push(sql)
        return original(sql)
      }) as typeof s.db.prepare
      let report
      try {
        report = readP7CostReport(s.db, { scope, experimentId: 'exp-1' })
      } finally {
        s.db.prepare = original
      }
      expect(statements).toHaveLength(1)
      expect(statements[0]?.trim().startsWith('SELECT')).toBe(true)
      expect(report.scopeSummary).toMatchObject({
        attempts: 3,
        settled: { actual: 10, count: 1 },
        unknown: { reserved: 10, count: 1 },
        held: { reserved: 30, count: 1 },
        committed: 50,
        hasUncertainCost: true,
        active: 1,
      })
      expect(report.selection.summary.committed).toBe(40)
      expect(report.scopeSummary.committed).toBe(s.ledger.totals().committed)
      expect(
        report.attributionGroups.find((g) => g.kind === 'unattributed')?.summary.committed,
      ).toBe(10)
      expect(stored(s.db)).toEqual(before)
      expect(pending.calls).toHaveLength(1)
      expect(s.ledger.rows()).toHaveLength(3)
    } finally {
      pending.release()
      await result
    }
  })

  it.each(['USAGE_MISSING', 'CONNECTION', 'CANCELLED', 'TIMEOUT'] as const)(
    '%s 不转为零费用且保留实际槽位口径',
    async (code) => {
      const s = setup()
      const pending = pendingTransport()
      const controller = new AbortController()
      let transmissions = 0
      const transport: P7Transport = {
        mode: 'simulation',
        async *stream() {
          transmissions++
          if (code === 'CONNECTION') throw new Error('offline disconnect')
          yield* frames('openai_chat', { missingUsage: true })
        },
      }
      const waits = code === 'TIMEOUT' || code === 'CANCELLED'
      s.roles.main_agent = roleConfig('main_agent', waits ? pending.transport : transport, 17, {
        timeoutMs: code === 'TIMEOUT' ? 20 : 1000,
      })
      const result = consume(createP7EvalModels({ ...s, signal: controller.signal }).agentModel)
      const assertion = expect(result).rejects.toMatchObject({ code })
      if (waits) {
        await pending.ready
        if (code === 'CANCELLED') controller.abort()
      }
      await assertion
      pending.release()
      const before = stored(s.db)
      const report = readP7CostReport(s.db, { scope })
      expect(waits ? pending.calls.length : transmissions).toBe(1)
      expect(s.ledger.rows()).toHaveLength(1)
      expect(report.scopeSummary).toMatchObject({
        unknown: { reserved: 17, count: 1 },
        settled: { actual: 0, count: 0 },
        committed: 17,
        hasUncertainCost: true,
        active: code === 'USAGE_MISSING' ? 0 : 1,
      })
      expect(report.calls[0]?.actual).toBeNull()
      expect(stored(s.db)).toEqual(before)
    },
  )

  it('缺失价格没有记录与明确零价结算严格区分', async () => {
    const s = setup()
    s.roles.main_agent = roleConfig('main_agent', s.transport.transport, 10, { price: null })
    await expect(consume(createP7EvalModels(s).agentModel)).rejects.toMatchObject({
      code: 'PRICE_MISSING',
    })
    const empty = readP7CostReport(s.db, { scope })
    expect(empty.scopeSummary).toMatchObject({ attempts: 0, observation: 'no_recorded_calls' })
    expect(empty.budget).toMatchObject({
      state: 'uninitialized',
      limit: null,
      remaining: null,
      blocked: null,
    })
    expect(s.transport.calls).toHaveLength(0)
    expect(s.ledger.rows()).toHaveLength(0)
    s.roles.main_agent = roleConfig('main_agent', s.transport.transport, 0)
    await consume(createP7EvalModels(s).agentModel)
    const zero = readP7CostReport(s.db, { scope })
    expect(zero.scopeSummary).toMatchObject({
      attempts: 1,
      settled: { actual: 0, count: 1 },
      hasUncertainCost: false,
      observation: 'recorded_calls',
    })
    expect(zero.calls[0]?.actual).toBe(0)
    expect(s.transport.calls).toHaveLength(1)
  })

  it('不同快照价格版本和不同 scope 保持分离', async () => {
    const s = setup()
    await consume(createP7EvalModels(s).agentModel)
    const old = s.roles.main_agent.snapshot
    s.roles.main_agent = roleConfig('main_agent', s.transport.transport, 10, {
      price: { ...old.price!, version: 'synthetic-new', fixedMicroPerCall: 23 },
    })
    await consume(createP7EvalModels({ ...s, identity: { ...s.identity, repeat: 2 } }).agentModel)
    const report = readP7CostReport(s.db, { scope })
    expect(new Set(report.calls.map((c) => c.snapshotVersion)).size).toBe(2)
    expect(new Set(report.calls.map((c) => c.priceVersion)).size).toBe(2)
    expect(report.scopeConfigurations).toHaveLength(2)
    expect(
      report.scopeConfigurations.map((c) => c.summary.committed).sort((a, b) => a - b),
    ).toEqual([10, 23])
    expect(report.scopeSummary.committed).toBe(33)
    expect(report.calls.find((c) => c.priceVersion === 'synthetic-new')?.actual).toBe(23)
    expect(readP7CostReport(s.db, { scope: 'live:first-real-cny-100' }).scopeSummary.attempts).toBe(
      0,
    )
  })

  it('超出预占如实结算并保留正剩余额度下的熔断', async () => {
    const s = setup()
    const snapshot = roleConfig('main_agent', s.transport.transport, 10, {
      price: { ...s.roles.main_agent.snapshot.price!, inputMicroPerMillion: 1_000_000 },
    }).snapshot
    await new P7Gateway(snapshot, s.ledger).invoke(
      { runId: 'over', purpose: 'main_agent' },
      async (_signal, usage) => {
        usage({ inputTokens: 200_000, outputTokens: 0 })
      },
    )
    const report = readP7CostReport(s.db, { scope })
    expect(report.scopeSummary.settled.actual).toBe(200_010)
    expect(report.calls[0]!.actual).toBeGreaterThan(report.calls[0]!.reserved)
    expect(report.budget.blocked).toBe(true)
    expect(report.budget.remaining).toBeGreaterThan(0)
    expect(report.observation.authorization).toBe(false)
  })

  it('旧身份非评测用途与异常身份均保留总额且不混入正常角色', async () => {
    const s = setup()
    const models = createP7EvalModels(s)
    const gateway = new P7Gateway(s.roles.main_agent.snapshot, s.ledger)
    const validRun = models.runIds.main_agent
    const cases = [
      { runId: 'old-run', purpose: 'main_agent' as const, operationId: 'old-operation' },
      { runId: 'embedding-run', purpose: 'embedding' as const, operationId: 'embedding-op' },
      { runId: validRun, purpose: 'judge' as const, operationId: JSON.stringify([validRun, 1]) },
      {
        runId: validRun,
        purpose: 'main_agent' as const,
        operationId: JSON.stringify([validRun, 0]),
      },
      { runId: `${validRun} `, purpose: 'main_agent' as const, operationId: 'noncanonical' },
    ]
    let transmissions = 0
    for (const context of cases)
      await gateway.invoke(context, async (_signal, usage) => {
        transmissions++
        usage({ inputTokens: 0, outputTokens: 0 })
      })
    const report = readP7CostReport(s.db, { scope, experimentId: 'exp-1' })
    expect(transmissions).toBe(5)
    expect(s.ledger.rows()).toHaveLength(5)
    expect(report.scopeSummary.committed).toBe(50)
    expect(report.selection.summary.committed).toBe(20)
    expect(report.attributionGroups.map((g) => [g.kind, g.summary.committed])).toEqual([
      ['eval', 0],
      ['unattributed', 30],
      ['anomaly', 20],
    ])
    expect(report.calls.map((c) => c.attribution.reason)).toEqual(
      expect.arrayContaining([
        'purpose_mismatch',
        'invalid_operation',
        'non_eval_purpose',
        'unrecognized_run',
      ]),
    )
  })

  it('损坏金额拒绝出具误导摘要且不修复账本', async () => {
    const s = setup()
    await consume(createP7EvalModels(s).agentModel)
    s.db.prepare('UPDATE p7_calls SET actual = NULL').run()
    const before = stored(s.db)
    expect(() => readP7CostReport(s.db, { scope })).toThrow('P7_COST_MISSING_ACTUAL')
    expect(stored(s.db)).toEqual(before)
  })

  it('多次已知 usage 的失败尝试也全部计费', async () => {
    const s = setup()
    const snapshot = roleConfig('main_agent', s.transport.transport, 11, {
      maxAttempts: 2,
    }).snapshot
    let transmissions = 0
    await new P7Gateway(snapshot, s.ledger).invoke(
      { runId: 'retry', purpose: 'main_agent', operationId: 'op' },
      async (_signal, usage) => {
        usage({ inputTokens: 1, outputTokens: 1 })
        if (++transmissions === 1) throw new P7Error('UPSTREAM')
      },
    )
    expect(transmissions).toBe(2)
    expect(s.ledger.rows()).toHaveLength(2)
    expect(readP7CostReport(s.db, { scope }).scopeSummary).toMatchObject({
      attempts: 2,
      logicalCalls: 1,
      settled: { actual: 22, count: 2 },
      committed: 22,
      hasUncertainCost: false,
    })
  })

  it('缺表明确报错不自动迁移也不创建预算', () => {
    const s = setup()
    s.db.exec('DROP TABLE p7_calls; DROP TABLE p7_run_snapshots; DROP TABLE p7_budgets')
    const before = s.db.prepare('SELECT name FROM sqlite_master ORDER BY name').all()
    expect(() => readP7CostReport(s.db, { scope })).toThrow('no such table')
    expect(s.db.prepare('SELECT name FROM sqlite_master ORDER BY name').all()).toEqual(before)
  })

  it('超出总预算不截断实际费用或负剩余额度', async () => {
    const s = setup()
    const snapshot = roleConfig('main_agent', s.transport.transport, 10, {
      price: { ...s.roles.main_agent.snapshot.price!, inputMicroPerMillion: 1_000_000 },
    }).snapshot
    await new P7Gateway(snapshot, s.ledger).invoke(
      { runId: 'over-limit', purpose: 'main_agent' },
      async (_signal, usage) => {
        usage({ inputTokens: 120_000_000, outputTokens: 0 })
      },
    )
    const report = readP7CostReport(s.db, { scope })
    expect(report.scopeSummary.committed).toBe(120_000_010)
    expect(report.budget).toMatchObject({ blocked: true, remaining: -20_000_010 })
    expect(report.scopeSummary.committed).toBe(s.ledger.totals().committed)
  })
})
