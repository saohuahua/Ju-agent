import { expect, it } from 'vitest'
import { SystemClock } from '@aftersales/domain'
import { ToolIO } from '@aftersales/contracts'
import { composeSystem } from '@aftersales/runtime'
import { resolveApiModelEntry } from '../src/model-entry.js'

it('正式模型装配不接受 live 或任意真实模式', () => {
  for (const mode of ['live', 'anthropic', 'production'])
    expect(() => resolveApiModelEntry(mode)).toThrow('LIVE_DISABLED')
  expect(resolveApiModelEntry().available).toBe(false)
  expect(resolveApiModelEntry('simulation').durableConversation?.snapshot.mode).toBe('simulation')
})

it.each([undefined, 'simulation'])('正式 %s 模式的旧模型端口始终拒绝调用', async (mode) => {
  const model = resolveApiModelEntry(mode).model
  await expect(
    (async () => {
      for await (const _event of model.stream()) throw new Error('不应产生模型事件')
    })(),
  ).rejects.toThrow('LIVE_DISABLED')
})

it('默认政策 scorer 使用关键词基线 不隐式调用主模型或新增费用', async () => {
  let calls = 0
  const system = composeSystem({
    clock: new SystemClock(),
    model: {
      info: { provider: 'offline-spy', model: 'sentinel' },
      async *stream() {
        calls++
        yield* []
        throw new Error('不应调用主模型')
      },
    },
  })
  try {
    const result = await system.executor.execute(
      'search_policy',
      { query: '质量问题 退货 退款' },
      { actor: { role: 'customer', customerId: 'C1001' }, runId: null, faults: null },
    )
    expect(ToolIO.search_policy.output.parse(result).articles.length).toBeGreaterThan(0)
    expect(calls).toBe(0)
    expect(system.db.prepare('SELECT COUNT(*) AS n FROM p7_calls').get()).toEqual({ n: 0 })
  } finally {
    system.db.close()
  }
})
