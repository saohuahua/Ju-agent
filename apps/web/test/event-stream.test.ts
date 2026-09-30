import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeEventStream } from '../src/lib/event-stream'

/** 保留旧回调以模拟浏览器已经排队但尚未派发的消息 */
class FakeEventSource {
  static current: FakeEventSource
  handlers = new Map<string, (event: Event) => void>()
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()

  constructor() {
    FakeEventSource.current = this
  }
  addEventListener(type: string, handler: (event: Event) => void) {
    this.handlers.set(type, handler)
  }
  emit(type: string, value: unknown) {
    this.handlers.get(type)?.({ data: JSON.stringify(value) } as MessageEvent)
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('浏览器事件源生命周期', () => {
  it('命名帧交付用户消息候选回复和暂停 格式错误不掩盖归约异常', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const callbacks = { onEvent: vi.fn(), onConnection: vi.fn(), onComplete: vi.fn() }
    subscribeEventStream('/events', callbacks)
    const source = FakeEventSource.current
    for (const type of ['message.user', 'order.candidates', 'message.completed', 'run.paused'])
      source.emit(type, { type })
    expect(callbacks.onEvent).toHaveBeenCalledTimes(4)
    source.handlers.get('message.user')?.({ data: 'invalid-json' } as MessageEvent)
    expect(callbacks.onEvent).toHaveBeenCalledTimes(4)
    callbacks.onEvent.mockImplementation(() => {
      throw new Error('归约错误')
    })
    expect(() => source.emit('message.user', {})).toThrow('归约错误')
  })
  it('业务终态不提前丢弃消息 完成帧才关闭并忽略迟到事件', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const callbacks = { onEvent: vi.fn(), onConnection: vi.fn(), onComplete: vi.fn() }
    subscribeEventStream('/events', callbacks)
    const source = FakeEventSource.current
    source.emit('run.completed', { sequence: 1 })
    expect(source.close).not.toHaveBeenCalled()
    source.emit('message.completed', { sequence: 2 })
    source.emit('stream.complete', { sequence: 2 })
    source.emit('message.completed', { sequence: 3 })
    source.onerror?.()
    expect(source.close).toHaveBeenCalledTimes(1)
    expect(callbacks.onComplete).toHaveBeenCalledTimes(1)
    expect(callbacks.onEvent).toHaveBeenCalledTimes(2)
    expect(callbacks.onConnection).toHaveBeenCalledTimes(1)
  })

  it('身份或案件切换清理订阅后旧消息和连接回调均被忽略', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const callbacks = { onEvent: vi.fn(), onConnection: vi.fn(), onComplete: vi.fn() }
    const close = subscribeEventStream('/old-events', callbacks)
    const old = FakeEventSource.current
    close()
    old.emit('operator.message', { text: '旧客户内容' })
    old.onopen?.()
    old.onerror?.()
    expect(callbacks.onEvent).not.toHaveBeenCalled()
    expect(callbacks.onConnection).not.toHaveBeenCalled()
  })
})
