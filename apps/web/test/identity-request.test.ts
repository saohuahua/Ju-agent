import { afterEach, describe, expect, it, vi } from 'vitest'
import { request, setToken } from '../src/lib/api'

afterEach(() => vi.unstubAllGlobals())

/** 延迟响应覆盖网络等待和响应体解析两个可能切换身份的窗口 */
function setup() {
  const storage = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    dispatchEvent: vi.fn(),
  })
  setToken('operator-token')
}

describe('请求身份隔离', () => {
  it('请求未完成时切换再切回身份也不能接受旧响应', async () => {
    setup()
    let deliver!: (value: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            deliver = resolve
          }),
      ),
    )
    const pending = request('/api/desk/cases')
    setToken('cust-token-1002')
    setToken('operator-token')
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    deliver(Response.json({ cases: [{ title: '旧案件' }] }))
    await rejected
  })

  it('响应体解析期间切换身份同样丢弃数据', async () => {
    setup()
    let deliver!: (value: unknown) => void
    const json = vi.fn(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json })),
    )
    const pending = request('/api/desk/cases')
    await vi.waitFor(() => expect(json).toHaveBeenCalled())
    setToken('cust-token-1002')
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    deliver({ cases: [{ title: '旧案件' }] })
    await rejected
  })
})
