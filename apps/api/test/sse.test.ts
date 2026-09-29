import { describe, expect, it, vi } from 'vitest'
import type { AgentEventRow } from '@aftersales/contracts'
import { createEventStream } from '../src/sse.js'

type StoredEvent = AgentEventRow & { payload: unknown }
const event = (sequence: number): StoredEvent => ({
  runId: 'run_test',
  sequence,
  type: 'message.completed',
  payload: { text: '完成' },
  createdAt: '2026-09-20T12:00:00Z',
})

describe('事件流生命周期', () => {
  it('消费者暂停读取时不持续预取历史事件', async () => {
    const listEvents = vi.fn(async (_id: string, from: number) => [event(from), event(from + 1)])
    const stream = createEventStream(
      { listEvents, isRunTerminal: async () => false },
      'run_test',
      0,
    )
    const reader = stream.getReader()
    await reader.read()
    await reader.read()
    const calls = listEvents.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(listEvents).toHaveBeenCalledTimes(calls)
    await reader.cancel()
  })

  it('终态检查期间写入的尾部事件仍会发送', async () => {
    const rows: StoredEvent[] = []
    const stream = createEventStream(
      {
        listEvents: async (_id, from) => rows.filter((row) => row.sequence >= from),
        isRunTerminal: async () => {
          if (rows.length === 0) rows.push(event(1))
          return true
        },
      },
      'run_test',
      0,
    )

    const body = await new Response(stream).text()
    expect(body).toContain('id: 1\nevent: message.completed')
    expect(body.indexOf('stream.complete')).toBeGreaterThan(body.indexOf('message.completed'))
  })

  it('浏览器取消后停止查询 不遗留永久轮询', async () => {
    const listEvents = vi.fn(async () => [])
    const stream = createEventStream(
      { listEvents, isRunTerminal: async () => false, pollIntervalMs: 1 },
      'run_test',
      0,
    )
    const reader = stream.getReader()
    await reader.read()
    await reader.cancel()
    const calls = listEvents.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(listEvents).toHaveBeenCalledTimes(calls)
  })

  it('超过存活时长时不发送完成帧', async () => {
    const stream = createEventStream(
      {
        listEvents: async () => [],
        isRunTerminal: async () => false,
        pollIntervalMs: 1,
        maxLifetimeMs: 5,
      },
      'run_test',
      0,
    )
    const body = await new Response(stream).text()
    expect(body).toContain(': server-refresh')
    expect(body).not.toContain('stream.complete')
  })

  it('查询故障不发送正常完成帧 允许客户端重连', async () => {
    const stream = createEventStream(
      {
        listEvents: async () => {
          throw new Error('storage')
        },
        isRunTerminal: async () => false,
      },
      'run_test',
      0,
    )
    expect(await new Response(stream).text()).not.toContain('stream.complete')
  })
})
