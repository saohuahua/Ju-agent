import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryDatabase, type SqliteDatabase } from '../../persistence/src/db.js'
import { P7Ledger } from '../../persistence/src/p7-ledger.js'
import { P7Gateway } from '../src/p7-gateway.js'
import { createP7Snapshot, p7Cost, p7Reservation, restoreP7Snapshot } from '../src/p7-snapshot.js'
import { config, frames, request, snapshot, streamFrames } from './p7-fixtures.js'
import type { P7Config, P7Purpose } from '../../contracts/src/p7-model-gateway.js'
import type { ModelStreamEvent } from '../../agent/src/model.js'

const databases: SqliteDatabase[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
function setup(overrides: Partial<P7Config> = {}) {
  const db = createMemoryDatabase()
  databases.push(db)
  const ledger = new P7Ledger(db)
  const gateway = new P7Gateway(createP7Snapshot(config(overrides)), ledger)
  return { db, ledger, gateway }
}
const context = { runId: 'run-1', purpose: 'main_agent' as const }

describe('P7 不可变快照', () => {
  it('序列化恢复和全局配置修改不影响原运行', () => {
    const original = config()
    const saved = createP7Snapshot(original)
    original.model = 'replacement'
    original.capabilities.tools = false
    expect(restoreP7Snapshot(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
    expect(saved.model).toBe('fixture-v1')
    expect(saved.capabilities.tools).toBe(true)
    expect(Object.isFrozen(saved.price)).toBe(true)
    expect(() => restoreP7Snapshot({ ...saved, model: 'replacement' })).toThrow('CONFIG')
  })
  it('未知字段和秘密拒绝进入快照', () => {
    expect(() => createP7Snapshot({ ...config(), apiKey: 'not-a-real-secret' })).toThrow()
  })
  it('同一运行不接受配置偷换', async () => {
    const { ledger, gateway } = setup()
    await gateway.invoke(context, async (_signal, usage) => {
      usage({ inputTokens: 1, outputTokens: 1 })
    })
    const next = new P7Gateway(createP7Snapshot(config({ model: 'new-model' })), ledger)
    await expect(next.invoke(context, async () => undefined)).rejects.toMatchObject({
      code: 'CONFIG',
    })
  })
})

describe('P7 统一预算', () => {
  it('整数费用和外币换算向上取整', () => {
    const price = {
      ...snapshot().price!,
      currency: 'USD' as const,
      fxNumerator: 7,
      fxDenominator: 1,
      inputMicroPerMillion: 1,
      outputMicroPerMillion: 0,
    }
    expect(p7Cost(price, { inputTokens: 1, outputTokens: 0 })).toBe(1)
    expect(p7Cost(price, { inputTokens: 1000000, outputTokens: 0 })).toBe(7)
  })
  it('价格缺失阻断调用 真实模式仅在计价后执行并记账', async () => {
    let calls = 0
    await expect(
      setup({ price: null }).gateway.invoke(context, async () => calls++),
    ).rejects.toMatchObject({ code: 'PRICE_MISSING' })
    expect(calls).toBe(0)
    const live = setup({ mode: 'live' })
    await live.gateway.invoke(context, async (_signal, usage) => {
      calls++
      usage({ inputTokens: 10, outputTokens: 5 })
    })
    expect(calls).toBe(1)
    expect(live.ledger.totals('live:first-real-cny-100').committed).toBeGreaterThan(0)
  })
  it('成功结算记录价格单位及币种', async () => {
    const { ledger, gateway, db } = setup()
    await gateway.invoke(context, async (_signal, usage) => {
      usage({ inputTokens: 10, outputTokens: 5 })
      return 'ok'
    })
    expect(ledger.totals()).toEqual({ committed: 20, active: 0 })
    expect(db.prepare('SELECT currency, unit, price_version FROM p7_calls').get()).toEqual({
      currency: 'CNY',
      unit: 'micro_yuan',
      price_version: 'synthetic-v1',
    })
  })
  it.each(['main_agent', 'sub_agent', 'embedding', 'rerank', 'simulator', 'judge'] as P7Purpose[])(
    '统一入口覆盖 %s',
    async (purpose) => {
      const { ledger, gateway } = setup()
      await gateway.invoke({ ...context, purpose }, async (_signal, usage) => {
        usage({ inputTokens: 10, outputTokens: 5 })
      })
      expect(ledger.totals().committed).toBe(20)
    },
  )
  it('不同用途和模型共享一百元累计限额', async () => {
    const price = { ...snapshot().price!, fixedMicroPerCall: 60000000 }
    const { ledger, gateway } = setup({ price })
    await gateway.invoke(context, async () => undefined)
    const judge = new P7Gateway(createP7Snapshot(config({ price, model: 'judge-model' })), ledger)
    await expect(
      judge.invoke({ runId: 'judge-run', purpose: 'judge' }, async () => undefined),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
    expect(ledger.rows()).toHaveLength(1)
  })
  it('同时在途调用受统一并发上限约束', async () => {
    const { ledger, gateway } = setup({ maxConcurrency: 1 })
    let release: () => void = () => undefined
    const first = gateway.invoke(
      context,
      async () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    await Promise.resolve()
    await expect(gateway.invoke(context, async () => undefined)).rejects.toMatchObject({
      code: 'CONCURRENCY',
    })
    release()
    await first
    expect(ledger.rows()).toHaveLength(1)
  })
  it.each([429, 500, 503])('错误 %i 重试逐次预占且保留未知金额', async (status) => {
    const { ledger, gateway } = setup({ maxAttempts: 3 })
    let calls = 0
    await expect(
      gateway.invoke(context, async () => {
        calls++
        throw Object.assign(new Error('模拟供应商错误'), { status })
      }),
    ).rejects.toMatchObject({ code: status === 429 ? 'RATE_LIMITED' : 'UPSTREAM' })
    expect(calls).toBe(3)
    expect(ledger.totals().committed).toBe(3 * p7Reservation(gateway.snapshot))
    expect(ledger.rows().every((row) => row.status === 'unknown')).toBe(true)
  })
  it('重试不能绕过累计额度', async () => {
    const { ledger, gateway } = setup({
      maxAttempts: 3,
      price: { ...snapshot().price!, fixedMicroPerCall: 60000000 },
    })
    let calls = 0
    await expect(
      gateway.invoke(context, async () => {
        calls++
        throw Object.assign(new Error('模拟限流'), { status: 429 })
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
    expect(calls).toBe(1)
    expect(ledger.rows()).toHaveLength(1)
  })
  it('超时即返回且迟到用量不能释放未知预占', async () => {
    const { ledger, gateway } = setup({ timeoutMs: 5, maxAttempts: 3 })
    let late: () => void = () => undefined
    let signal: AbortSignal | undefined
    await expect(
      gateway.invoke(context, (s, usage) => {
        signal = s
        return new Promise<void>((resolve) => {
          late = () => {
            usage({ inputTokens: 0, outputTokens: 0 })
            resolve()
          }
        })
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
    late()
    await Promise.resolve()
    expect(signal?.aborted).toBe(true)
    expect(ledger.totals().committed).toBe(p7Reservation(gateway.snapshot))
    expect(ledger.rows()).toHaveLength(1)
  })
  it('取消前不记账 取消在途保留未知费用', async () => {
    const { ledger, gateway } = setup()
    const before = new AbortController()
    before.abort()
    await expect(
      gateway.invoke({ ...context, signal: before.signal }, async () => undefined),
    ).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(ledger.rows()).toHaveLength(0)
    const during = new AbortController()
    const active = gateway.invoke(
      { ...context, signal: during.signal },
      async () => new Promise(() => undefined),
    )
    during.abort()
    await expect(active).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(ledger.rows()[0]?.status).toBe('unknown')
  })
  it('重复逻辑尝试不能再次执行供应商调用', async () => {
    const { gateway } = setup()
    let calls = 0
    await gateway.invoke({ ...context, operationId: 'stable' }, async () => calls++)
    await expect(
      gateway.invoke({ ...context, operationId: 'stable' }, async () => calls++),
    ).rejects.toThrow()
    expect(calls).toBe(1)
  })
  it('供应商超报上界记录实耗并熔断后续调用', async () => {
    const { gateway, ledger } = setup()
    await gateway.invoke(context, async (_signal, usage) =>
      usage({ inputTokens: 1000000000, outputTokens: 0 }),
    )
    expect(ledger.totals().committed).toBe(1000000000)
    await expect(gateway.invoke(context, async () => undefined)).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    })
  })
})

describe.each(['anthropic_messages', 'openai_chat'] as const)('P7 独立组合根 %s', (protocol) => {
  it.each([429, 500])('传输错误 %i 经网关归一并记录每次尝试', async (status) => {
    const { ledger, gateway } = setup({ protocol, maxAttempts: 2 })
    const model = gateway.chatModel('run', 'main_agent', {
      mode: 'simulation',
      async *stream() {
        throw Object.assign(new Error('故障注入'), { status })
      },
    })
    await expect(
      (async () => {
        for await (const _event of model.stream(request)) {
          /* 异常流不产出事件 */
        }
      })(),
    ).rejects.toMatchObject({ code: status === 429 ? 'RATE_LIMITED' : 'UPSTREAM' })
    expect(ledger.rows()).toHaveLength(2)
    expect(ledger.totals().committed).toBe(2 * p7Reservation(gateway.snapshot))
  })
  it('连接中断保留额度和在途槽且不自动重试', async () => {
    const { ledger, gateway } = setup({ protocol, maxAttempts: 3, maxConcurrency: 1 })
    const model = gateway.chatModel('run', 'main_agent', {
      mode: 'simulation',
      async *stream() {
        yield frames(protocol)[0]
        throw new Error('connection lost')
      },
    })
    await expect(
      (async () => {
        for await (const _event of model.stream(request)) {
          /* 异常流不产出事件 */
        }
      })(),
    ).rejects.toMatchObject({ code: 'CONNECTION' })
    expect(ledger.rows()).toHaveLength(1)
    expect(ledger.totals()).toEqual({ committed: p7Reservation(gateway.snapshot), active: 1 })
    await expect(gateway.invoke(context, async () => undefined)).rejects.toMatchObject({
      code: 'CONCURRENCY',
    })
  })
  it('截断仍结算已知用量且不交付部分工具', async () => {
    const { ledger, gateway } = setup({ protocol })
    const model = gateway.chatModel('run', 'main_agent', {
      mode: 'simulation',
      stream: () => streamFrames(frames(protocol, { tools: 1, truncated: true })),
    })
    const events: ModelStreamEvent[] = []
    await expect(
      (async () => {
        for await (const event of model.stream(request)) events.push(event)
      })(),
    ).rejects.toMatchObject({ code: 'TRUNCATED' })
    expect(events).toHaveLength(0)
    expect(ledger.totals().committed).toBe(20)
  })
  it('流不响应取消时本地超时仍能结束', async () => {
    const { ledger, gateway } = setup({ protocol, timeoutMs: 5 })
    const model = gateway.chatModel('run', 'main_agent', {
      mode: 'simulation',
      async *stream() {
        await new Promise(() => undefined)
      },
    })
    await expect(
      (async () => {
        for await (const _event of model.stream(request)) {
          /* 超时流不产出事件 */
        }
      })(),
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(ledger.rows()[0]?.outcome).toBe('TIMEOUT')
  })
  it('原循环接口经过协议与账本', async () => {
    const { ledger, gateway } = setup({ protocol })
    const model = gateway.chatModel('run', 'main_agent', {
      mode: 'simulation',
      stream: () => streamFrames(frames(protocol, { tools: 2 })),
    })
    const events: ModelStreamEvent[] = []
    for await (const event of model.stream(request)) events.push(event)
    expect(events.at(-1)?.type).toBe('turn_completed')
    expect(ledger.totals().committed).toBe(20)
  })
  it('缺失 usage 不伪造零用量且保留预占', async () => {
    const { ledger, gateway } = setup({ protocol })
    const model = gateway.chatModel('run', 'judge', {
      mode: 'simulation',
      stream: () => streamFrames(frames(protocol, { missingUsage: true })),
    })
    await expect(
      (async () => {
        for await (const _event of model.stream(request)) {
          /* 完成前不交付任何事件 */
        }
      })(),
    ).rejects.toMatchObject({ code: 'USAGE_MISSING' })
    expect(ledger.rows()[0]?.status).toBe('unknown')
    expect(ledger.totals().committed).toBe(p7Reservation(gateway.snapshot))
  })
  it('畸形工具参数阻断执行但已知用量仍结算', async () => {
    const { ledger, gateway } = setup({ protocol })
    const model = gateway.chatModel('run', 'main_agent', {
      mode: 'simulation',
      stream: () => streamFrames(frames(protocol, { tools: 1, json: ['{'] })),
    })
    const events: ModelStreamEvent[] = []
    await expect(
      (async () => {
        for await (const event of model.stream(request)) events.push(event)
      })(),
    ).rejects.toMatchObject({ code: 'PROTOCOL' })
    expect(events).toHaveLength(0)
    expect(ledger.totals().committed).toBe(20)
  })
})
