import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/lib/api'
import { createRequestKey } from '../src/lib/request-key'

afterEach(() => vi.unstubAllGlobals())

describe('请求键兼容性', () => {
  it('支持原生 UUID 时保留原生实现的调用上下文', () => {
    const crypto = {
      randomUUID() {
        expect(this).toBe(crypto)
        return '11111111-1111-4111-8111-111111111111'
      },
    }
    vi.stubGlobal('crypto', crypto)
    expect(createRequestKey()).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('随机字节回退保持补零和 UUID 版本变体', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(0),
    })
    expect(createRequestKey()).toBe('00000000-0000-4000-8000-000000000000')
  })

  it.each([undefined, {}])('随机数接口整体不可用时明确报错', (crypto) => {
    vi.stubGlobal('crypto', crypto)
    expect(() => createRequestKey()).toThrow('当前浏览器无法生成安全请求标识')
  })

  it('缺少原生 UUID 方法时仍能发送新对话和后续消息', async () => {
    // 模拟普通 HTTP 环境只暴露随机字节接口
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) })
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ runId: 'run-test' }))
    vi.stubGlobal('fetch', fetchMock)

    await api.createRun('查询订单')
    await api.continueRun('run-test', '继续查询')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get('Idempotency-Key'),
    )
    for (const key of keys) {
      expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
    expect(keys[0]).not.toBe(keys[1])
  })

  it('重试时保留调用方传入的请求键', async () => {
    vi.stubGlobal('crypto', {})
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ runId: 'run-test' }))
    vi.stubGlobal('fetch', fetchMock)

    await api.createRun('查询订单', undefined, 'same-request')
    await api.continueRun('run-test', '继续查询', 'same-request')

    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('same-request')
    }
  })
})
