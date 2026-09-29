import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/lib/api'
import { runDetailOptions } from '../src/lib/run-detail-query'
import type { AgentEvent, RunSummary } from '../src/lib/types'

const clients: QueryClient[] = []

function setup(runId = 'run_a') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  clients.push(client)
  const run: RunSummary = {
    runId,
    customerId: 'customer-a',
    status: 'running',
    intent: null,
    promptVersion: 'test',
    model: 'test',
    error: null,
    source: 'sim',
    createdAt: '2026-09-28T00:00:00Z',
    updatedAt: '2026-09-28T00:00:00Z',
  }
  vi.spyOn(api, 'getRun').mockResolvedValue({ run })
  vi.spyOn(api, 'getRating').mockResolvedValue({ rating: null })
  return { client, options: runDetailOptions(client, runId) }
}

function event(sequence: number): AgentEvent {
  return {
    runId: 'run_a',
    sequence,
    type: 'agent.turn',
    payload: { turn: sequence },
    createdAt: '2026-09-28T00:00:00Z',
  }
}

afterEach(() => {
  for (const client of clients.splice(0)) client.clear()
  vi.restoreAllMocks()
})

describe('运行详情增量查询', () => {
  it('首屏读历史 后续只读新增事件 空轮询保留已有事件引用', async () => {
    const { client, options } = setup()
    const list = vi
      .spyOn(api, 'listEvents')
      .mockResolvedValueOnce({ events: [event(1), event(2)] })
      .mockResolvedValueOnce({ events: [event(3)] })
      .mockResolvedValueOnce({ events: [] })

    await client.fetchQuery(options)
    const second = await client.fetchQuery(options)
    const cached = client.getQueryData(options.queryKey)
    await client.fetchQuery(options)

    expect(list.mock.calls.map((call) => call[1])).toEqual([1, 3, 4])
    expect(second.events.map((entry) => entry.sequence)).toEqual([1, 2, 3])
    expect(client.getQueryData(options.queryKey)?.events).toBe(cached?.events)
  })

  it('失败不会推进游标 再次读取仍能补齐失败窗口中的事件', async () => {
    const { client, options } = setup()
    const list = vi
      .spyOn(api, 'listEvents')
      .mockResolvedValueOnce({ events: [event(1)] })
      .mockRejectedValueOnce(new Error('离线'))
      .mockResolvedValueOnce({ events: [event(2), event(3)] })

    await client.fetchQuery(options)
    await expect(client.fetchQuery(options)).rejects.toThrow('离线')
    const result = await client.fetchQuery(options)

    expect(list.mock.calls.map((call) => call[1])).toEqual([1, 2, 2])
    expect(result.events.map((entry) => entry.sequence)).toEqual([1, 2, 3])
  })

  it('并发读取共享在途请求 不会把同一增量追加两遍', async () => {
    const { client, options } = setup()
    let deliver!: (value: { events: AgentEvent[] }) => void
    const list = vi.spyOn(api, 'listEvents').mockImplementation(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        }),
    )
    const first = client.fetchQuery(options)
    const second = client.fetchQuery(options)
    deliver({ events: [event(1)] })

    expect((await first).events).toEqual([event(1)])
    expect((await second).events).toEqual([event(1)])
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('切换案件从独立游标开始 返回原案件继续补读', async () => {
    const { client, options } = setup()
    const list = vi
      .spyOn(api, 'listEvents')
      .mockResolvedValueOnce({ events: [event(1)] })
      .mockResolvedValueOnce({ events: [] })
      .mockResolvedValueOnce({ events: [event(2)] })

    await client.fetchQuery(options)
    await client.fetchQuery(runDetailOptions(client, 'run_b'))
    const result = await client.fetchQuery(options)

    expect(list.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['run_a', 1],
      ['run_b', 1],
      ['run_a', 2],
    ])
    expect(result.events.map((entry) => entry.sequence)).toEqual([1, 2])
  })

  it('取消请求保留原缓存 下一次仍读取尚未提交的增量', async () => {
    const { client, options } = setup()
    const list = vi.spyOn(api, 'listEvents').mockResolvedValueOnce({ events: [event(1)] })
    await client.fetchQuery(options)
    list.mockImplementationOnce(
      (_runId, _from, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')))
        }),
    )
    const pending = client.fetchQuery(options)
    await client.cancelQueries({ queryKey: options.queryKey })
    await pending
    expect(list.mock.calls[1]?.[2]?.aborted).toBe(true)
    list.mockResolvedValueOnce({ events: [event(2)] })
    const result = await client.fetchQuery(options)

    expect(list.mock.calls.map((call) => call[1])).toEqual([1, 2, 2])
    expect(result.events.map((entry) => entry.sequence)).toEqual([1, 2])
  })

  it('写后刷新取消旧快照请求并读取写入后的事件', async () => {
    const { client, options } = setup()
    const list = vi.spyOn(api, 'listEvents').mockResolvedValueOnce({ events: [event(1)] })
    await client.fetchQuery(options)
    list.mockImplementationOnce(
      (_runId, _from, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')))
        }),
    )
    const observer = new QueryObserver(client, { ...options, enabled: false })
    const unsubscribe = observer.subscribe(() => {})
    try {
      const background = observer.refetch()
      list.mockResolvedValueOnce({ events: [event(2)] })
      await client.cancelQueries({ queryKey: options.queryKey, exact: true })
      const afterWrite = await observer.refetch()
      await background

      expect(list.mock.calls[1]?.[2]?.aborted).toBe(true)
      expect(list.mock.calls.map((call) => call[1])).toEqual([1, 2, 2])
      expect(afterWrite.data?.events.map((entry) => entry.sequence)).toEqual([1, 2])
      expect(client.getQueryData(options.queryKey)?.events.map((entry) => entry.sequence)).toEqual([
        1, 2,
      ])
    } finally {
      unsubscribe()
    }
  })

  it('首次读取还没有缓存时写后刷新也必须重发请求', async () => {
    const { client, options } = setup()
    const list = vi.spyOn(api, 'listEvents').mockImplementationOnce(
      (_runId, _from, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')))
        }),
    )
    const observer = new QueryObserver(client, { ...options, enabled: false })
    const unsubscribe = observer.subscribe(() => {})
    try {
      const initial = observer.refetch()
      list.mockResolvedValueOnce({ events: [event(1), event(2)] })
      await client.cancelQueries({ queryKey: options.queryKey, exact: true })
      const afterWrite = await observer.refetch()
      await initial

      expect(list.mock.calls[0]?.[2]?.aborted).toBe(true)
      expect(list.mock.calls.map((call) => call[1])).toEqual([1, 1])
      expect(afterWrite.data?.events.map((entry) => entry.sequence)).toEqual([1, 2])
    } finally {
      unsubscribe()
    }
  })
})
