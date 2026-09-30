import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryDatabase, type SqliteDatabase } from '../../persistence/src/db.js'
import { P7Ledger } from '../../persistence/src/p7-ledger.js'
import { P7Error } from '../../contracts/src/p7-model-gateway.js'
import type { P7Transport } from '../../runtime/src/p7-gateway.js'
import { frames, streamFrames } from '../../runtime/test/p7-fixtures.js'
import { composeAgentSystem, seedOrder, startRun } from '../../agent/test/helpers.js'
import { createP7EvalModels, type P7EvalIdentity } from '../src/p7-eval-models.js'
import { UserSimulator } from '../src/simulator.js'
import { judgeTranscript } from '../src/judge.js'
import {
  consume,
  offline,
  pendingTransport,
  roleConfig,
  scenario,
} from './fixtures/p7-eval-fixtures.js'

const databases: SqliteDatabase[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

/** 每个测试使用独立内存库 保留真实账本和真实消费者 */
function setup(fixedMicroPerCall = 10) {
  const db = createMemoryDatabase()
  databases.push(db)
  const ledger = new P7Ledger(db)
  const agent = offline()
  const simulator = offline('anthropic_messages')
  const judge = offline('openai_chat', '[{"rubric":"礼貌","passed":false,"reason":"未问候"}]')
  const roles = {
    main_agent: roleConfig('main_agent', agent.transport, fixedMicroPerCall),
    simulator: roleConfig('simulator', simulator.transport, fixedMicroPerCall, {
      protocol: 'anthropic_messages',
    }),
    judge: roleConfig('judge', judge.transport, fixedMicroPerCall),
  }
  const identity = { experimentId: 'experiment-1', caseId: 'case-1', repeat: 1 }
  const models = createP7EvalModels({ ledger, roles, identity })
  return { db, ledger, roles, identity, models, agent, simulator, judge }
}

describe('P7 评测预算独立组合', () => {
  it('真实主循环收到网关重试耗尽后不再叠加模型重试', async () => {
    const s = setup()
    let calls = 0
    const transport: P7Transport = {
      mode: 'simulation',
      stream() {
        calls++
        throw new P7Error('RATE_LIMITED')
      },
    }
    s.roles.main_agent = roleConfig('main_agent', transport, 10, { maxAttempts: 2 })
    const models = createP7EvalModels({ ledger: s.ledger, roles: s.roles, identity: s.identity })
    const system = composeAgentSystem([], 4, models.agentModel)
    const result = await startRun(system, { role: 'customer', customerId: 'C1001' }, '查询订单')
    expect(result.outcome).toBe('failed')
    expect(calls).toBe(2)
    expect(s.ledger.rows()).toHaveLength(2)
    expect(s.ledger.totals().committed).toBe(20)
  })

  it('真实模拟器连续两轮与 Judge 共用被测模型账本', async () => {
    const s = setup()
    const simulator = new UserSimulator({ model: s.models.userModel, scenario })
    expect((await simulator.openingMessage()).text).toBe('我要查询订单')
    const events = await consume(s.models.agentModel)
    expect((await simulator.replyTo('请提供订单号')).text).toBe('我要查询订单')
    expect(
      await judgeTranscript(
        { model: s.models.judgeModel },
        ['礼貌'],
        [{ role: 'agent', text: '订单号' }],
      ),
    ).toEqual([{ rubric: '礼貌', reason: '未问候' }])
    expect([s.agent.calls.length, s.simulator.calls.length, s.judge.calls.length]).toEqual([
      1, 2, 1,
    ])
    expect(s.ledger.rows()).toHaveLength(4)
    expect(s.ledger.totals()).toEqual({ committed: 40, active: 0 })
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed', usage: { costUsd: null } })
    const rows = s.db
      .prepare(
        'SELECT run_id, operation_id, purpose, attempt, snapshot_version, currency, unit FROM p7_calls',
      )
      .all() as Array<Record<string, unknown>>
    for (const role of ['main_agent', 'simulator', 'judge'] as const) {
      const selected = rows.filter((row) => row.purpose === role)
      expect(selected).toHaveLength(role === 'simulator' ? 2 : 1)
      selected.forEach((row, index) =>
        expect(row).toEqual({
          run_id: s.models.runIds[role],
          operation_id: JSON.stringify([s.models.runIds[role], index + 1]),
          purpose: role,
          attempt: 1,
          snapshot_version: s.roles[role].snapshot.version,
          currency: 'CNY',
          unit: 'micro_yuan',
        }),
      )
    }
    expect(s.agent.calls[0]?.body.model).toBe('offline-main_agent')
    expect(s.simulator.calls[0]?.body.model).toBe('offline-simulator')
    expect(s.judge.calls[0]?.body.model).toBe('offline-judge')
  })

  it('真实主 Agent 查单后结案两轮均通过工厂记账', async () => {
    const s = setup()
    let calls = 0
    const transport: P7Transport = {
      mode: 'simulation',
      stream() {
        calls++
        return streamFrames(
          frames(
            'openai_chat',
            calls === 1
              ? {
                  tools: 1,
                  toolName: 'get_order',
                  json: ['{"orderNo":"SO-2026-0003"}'],
                  idPrefix: 'lookup',
                }
              : {
                  tools: 1,
                  toolName: 'conclude',
                  json: ['{"summary":"查单完成"}'],
                  idPrefix: 'done',
                },
          ),
        )
      },
    }
    s.roles.main_agent = roleConfig('main_agent', transport)
    const models = createP7EvalModels({ ledger: s.ledger, roles: s.roles, identity: s.identity })
    const system = composeAgentSystem([], 4, models.agentModel)
    seedOrder(system.repos, {
      orderNo: 'SO-2026-0003',
      status: 'delivered',
      deliveredAt: '2026-09-15T12:00:00.000Z',
    })
    const result = await startRun(
      system,
      { role: 'customer', customerId: 'C1001' },
      '查询订单 SO-2026-0003',
    )
    expect(result.outcome).toBe('completed')
    expect(calls).toBe(2)
    expect(s.ledger.rows()).toHaveLength(2)
    expect(s.ledger.totals().committed).toBe(20)
    expect(s.db.prepare('SELECT DISTINCT purpose FROM p7_calls').all()).toEqual([
      { purpose: 'main_agent' },
    ])
  })

  it('先前主模型费用同时阻断真实模拟器和 Judge 且后两者零传输', async () => {
    const s = setup(60_000_000)
    await consume(s.models.agentModel)
    await expect(
      new UserSimulator({ model: s.models.userModel, scenario }).openingMessage(),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
    await expect(
      judgeTranscript({ model: s.models.judgeModel }, ['礼貌'], []),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
    expect([s.agent.calls.length, s.simulator.calls.length, s.judge.calls.length]).toEqual([
      1, 0, 0,
    ])
    expect(s.ledger.rows()).toHaveLength(1)
    expect(s.ledger.totals().committed).toBe(60_000_000)
  })

  it('模拟器和 Judge 的先前费用也阻断后续主模型', async () => {
    const s = setup(40_000_000)
    await new UserSimulator({ model: s.models.userModel, scenario }).openingMessage()
    await judgeTranscript({ model: s.models.judgeModel }, ['礼貌'], [])
    await expect(consume(s.models.agentModel)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
    expect([s.agent.calls.length, s.simulator.calls.length, s.judge.calls.length]).toEqual([
      0, 1, 1,
    ])
    expect(s.ledger.rows()).toHaveLength(2)
    expect(s.ledger.totals().committed).toBe(80_000_000)
  })

  it('不同实验用例与重复轮次独立归因但不创建新预算', async () => {
    const s = setup()
    const identities = [
      s.identity,
      { ...s.identity, caseId: 'case-2' },
      { ...s.identity, repeat: 2 },
      { ...s.identity, experimentId: 'experiment-2' },
    ]
    for (const identity of identities) {
      const models = createP7EvalModels({ ledger: s.ledger, roles: s.roles, identity })
      await consume(models.agentModel)
    }
    expect(s.agent.calls).toHaveLength(4)
    expect(s.ledger.rows()).toHaveLength(4)
    expect(s.db.prepare('SELECT DISTINCT run_id FROM p7_calls').all()).toHaveLength(4)
    expect(s.db.prepare('SELECT * FROM p7_budgets').all()).toHaveLength(1)
  })

  it('同一身份重建模型不能重放已记账尝试', async () => {
    const s = setup()
    await consume(s.models.agentModel)
    const rebuilt = createP7EvalModels({ ledger: s.ledger, roles: s.roles, identity: s.identity })
    await expect(consume(rebuilt.agentModel)).rejects.toThrow()
    expect(s.agent.calls).toHaveLength(1)
    expect(s.ledger.rows()).toHaveLength(1)
  })

  it('并发预占使另一用途在传输前拒绝', async () => {
    const s = setup(60_000_000)
    const pending = pendingTransport()
    s.roles.main_agent = roleConfig('main_agent', pending.transport, 60_000_000)
    const models = createP7EvalModels({ ledger: s.ledger, roles: s.roles, identity: s.identity })
    const first = consume(models.agentModel)
    await pending.ready
    try {
      expect(s.ledger.rows()[0]).toMatchObject({ status: 'held', reserved: 60_000_000 })
      await expect(
        new UserSimulator({ model: models.userModel, scenario }).openingMessage(),
      ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
      expect(pending.calls).toHaveLength(1)
      expect(s.simulator.calls).toHaveLength(0)
      expect(s.ledger.rows()).toHaveLength(1)
    } finally {
      pending.release()
    }
    await first
    expect(s.ledger.totals()).toEqual({ committed: 60_000_000, active: 0 })
  })

  it.each(['CANCELLED', 'TIMEOUT'] as const)(
    '%s 保留未知费用与槽位且信号到达传输',
    async (code) => {
      const s = setup()
      const pending = pendingTransport()
      const controller = new AbortController()
      s.roles.simulator = roleConfig('simulator', pending.transport, 60_000_000, {
        timeoutMs: code === 'TIMEOUT' ? 20 : 1000,
      })
      const models = createP7EvalModels({
        ledger: s.ledger,
        roles: s.roles,
        identity: s.identity,
        signal: controller.signal,
      })
      const result = new UserSimulator({ model: models.userModel, scenario }).openingMessage()
      const assertion = expect(result).rejects.toMatchObject({ code })
      await pending.ready
      if (code === 'CANCELLED') controller.abort()
      await assertion
      expect(pending.calls).toHaveLength(1)
      expect(pending.calls[0]?.aborted).toBe(true)
      expect(s.ledger.rows()).toHaveLength(1)
      expect(s.ledger.rows()[0]).toMatchObject({
        status: 'unknown',
        actual: null,
        reserved: 60_000_000,
        outcome: code,
      })
      expect(s.ledger.totals()).toEqual({ committed: 60_000_000, active: 1 })
      pending.release()
    },
  )

  it('调用前取消不预占也不传输', async () => {
    const s = setup()
    const controller = new AbortController()
    controller.abort()
    const models = createP7EvalModels({
      ledger: s.ledger,
      roles: s.roles,
      identity: s.identity,
      signal: controller.signal,
    })
    await expect(consume(models.agentModel)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(s.agent.calls).toHaveLength(0)
    expect(s.ledger.rows()).toHaveLength(0)
  })

  it.each(['USAGE_MISSING', 'CONNECTION', 'TRUNCATED'] as const)(
    '%s 按已知用量结算或保留未知预占',
    async (code) => {
      const s = setup()
      let calls = 0
      const transport: P7Transport = {
        mode: 'simulation',
        async *stream() {
          calls++
          if (code === 'CONNECTION') {
            yield { choices: [{ index: 0, delta: { content: '未完成' }, finish_reason: null }] }
            throw new Error('offline disconnect')
          }
          yield* frames('openai_chat', {
            missingUsage: code === 'USAGE_MISSING',
            truncated: code === 'TRUNCATED',
          })
        },
      }
      s.roles.judge = roleConfig('judge', transport, 60_000_000)
      const models = createP7EvalModels({ ledger: s.ledger, roles: s.roles, identity: s.identity })
      await expect(
        judgeTranscript({ model: models.judgeModel }, ['礼貌'], []),
      ).rejects.toMatchObject({ code })
      expect(calls).toBe(1)
      expect(s.ledger.rows()).toHaveLength(1)
      expect(s.ledger.rows()[0]).toMatchObject({
        outcome: code,
        status: code === 'TRUNCATED' ? 'settled' : 'unknown',
        actual: code === 'TRUNCATED' ? 60_000_000 : null,
      })
      expect(s.ledger.totals()).toEqual({
        committed: 60_000_000,
        active: code === 'CONNECTION' ? 1 : 0,
      })
      s.roles.main_agent = roleConfig('main_agent', s.agent.transport, 60_000_000)
      const later = createP7EvalModels({
        ledger: s.ledger,
        roles: s.roles,
        identity: { ...s.identity, caseId: 'later' },
      })
      await expect(consume(later.agentModel)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
      expect(s.agent.calls).toHaveLength(0)
      expect(s.ledger.rows()).toHaveLength(1)
    },
  )

  it.each([429, 503])('供应商 %s 重试每次实际尝试独立记账', async (status) => {
    const s = setup()
    let calls = 0
    const transport: P7Transport = {
      mode: 'simulation',
      stream() {
        calls++
        if (calls === 1) throw Object.assign(new Error('offline retry'), { status })
        return streamFrames(frames('openai_chat'))
      },
    }
    s.roles.simulator = roleConfig('simulator', transport, 10, { maxAttempts: 2 })
    const models = createP7EvalModels({ ledger: s.ledger, roles: s.roles, identity: s.identity })
    await new UserSimulator({ model: models.userModel, scenario }).openingMessage()
    expect(calls).toBe(2)
    expect(s.ledger.rows()).toHaveLength(2)
    expect(
      s.db.prepare('SELECT operation_id, attempt, status FROM p7_calls ORDER BY attempt').all(),
    ).toEqual([
      { operation_id: JSON.stringify([models.runIds.simulator, 1]), attempt: 1, status: 'unknown' },
      { operation_id: JSON.stringify([models.runIds.simulator, 1]), attempt: 2, status: 'settled' },
    ])
    expect(s.ledger.totals()).toEqual({ committed: 20, active: 0 })
  })

  it('失败尝试已占预算时网关重试零新增传输', async () => {
    const s = setup()
    let calls = 0
    const transport: P7Transport = {
      mode: 'simulation',
      stream() {
        calls++
        throw new P7Error('UPSTREAM')
      },
    }
    s.roles.judge = roleConfig('judge', transport, 60_000_000, { maxAttempts: 3 })
    const models = createP7EvalModels({ ledger: s.ledger, roles: s.roles, identity: s.identity })
    await expect(judgeTranscript({ model: models.judgeModel }, ['礼貌'], [])).rejects.toMatchObject(
      { code: 'BUDGET_EXCEEDED' },
    )
    expect(calls).toBe(1)
    expect(s.ledger.rows()).toHaveLength(1)
    expect(s.ledger.rows()[0]).toMatchObject({
      status: 'unknown',
      outcome: 'UPSTREAM',
      actual: null,
    })
  })

  it('供应商连续失败只执行快照允许的尝试且重建不会绕过首尝试', async () => {
    const s = setup()
    let calls = 0
    const transport: P7Transport = {
      mode: 'simulation',
      stream() {
        calls++
        throw new P7Error('RATE_LIMITED')
      },
    }
    s.roles.simulator = roleConfig('simulator', transport, 10, { maxAttempts: 3 })
    const input = { ledger: s.ledger, roles: s.roles, identity: s.identity }
    await expect(
      new UserSimulator({ model: createP7EvalModels(input).userModel, scenario }).openingMessage(),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    await expect(
      new UserSimulator({ model: createP7EvalModels(input).userModel, scenario }).openingMessage(),
    ).rejects.toThrow()
    expect(calls).toBe(3)
    expect(s.ledger.rows()).toHaveLength(3)
    expect(s.ledger.rows().every((row) => row.status === 'unknown' && row.actual === null)).toBe(
      true,
    )
    expect(s.ledger.totals().committed).toBe(30)
  })

  it('缺失价格拒绝消费而非标记免费', async () => {
    const s = setup()
    s.roles.judge = roleConfig('judge', s.judge.transport, 10, { price: null })
    const models = createP7EvalModels({ ledger: s.ledger, roles: s.roles, identity: s.identity })
    await expect(judgeTranscript({ model: models.judgeModel }, ['礼貌'], [])).rejects.toMatchObject(
      { code: 'PRICE_MISSING' },
    )
    expect(s.judge.calls).toHaveLength(0)
    expect(s.ledger.rows()).toHaveLength(0)
  })

  it('拒绝非法身份和篡改快照并保持 live 禁用', () => {
    const s = setup()
    for (const identity of [
      { ...s.identity, experimentId: '' },
      { ...s.identity, caseId: ' ' },
      { ...s.identity, repeat: 0 },
      { ...s.identity, repeat: 1.5 },
    ] satisfies P7EvalIdentity[]) {
      expect(() => createP7EvalModels({ ledger: s.ledger, roles: s.roles, identity })).toThrow(
        'CONFIG',
      )
    }
    s.roles.judge.snapshot = { ...s.roles.judge.snapshot, model: 'tampered' }
    expect(() =>
      createP7EvalModels({ ledger: s.ledger, roles: s.roles, identity: s.identity }),
    ).toThrow('CONFIG')
    s.roles.judge = roleConfig('judge', s.judge.transport, 10, { mode: 'live' })
    expect(() =>
      createP7EvalModels({ ledger: s.ledger, roles: s.roles, identity: s.identity }),
    ).toThrow('LIVE_DISABLED')
    expect(s.ledger.rows()).toHaveLength(0)
    expect(s.judge.calls).toHaveLength(0)
  })
})
