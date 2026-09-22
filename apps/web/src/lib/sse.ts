/**
 * SSE 订阅 Hook
 *
 * 浏览器原生 EventSource 断线自动重连并携带 Last-Event-ID
 * 服务端从持久化事件表补发 时间线不丢不重
 */

'use client'

import { useEffect, useRef, useState } from 'react'
import { API_BASE, currentToken } from './api'
import { initialViewState, reduceEvent, type RunViewState } from './runReducer'
import type { AgentEvent } from './types'

export interface SseSession {
  state: RunViewState
  connected: boolean
}

/**
 * 订阅运行事件流
 *
 * 连接建立后先全量归约重建状态 再增量消费新事件
 * EventSource 断线由浏览器自动重连 序号去重在归约器中完成
 */
export function useRunEvents(runId: string | null): SseSession {
  const [state, setState] = useState<RunViewState>(initialViewState)
  const [connected, setConnected] = useState(false)
  const stateRef = useRef(state)

  useEffect(() => {
    if (!runId) {
      setState(initialViewState())
      setConnected(false)
      return
    }

    setState(initialViewState())
    stateRef.current = initialViewState()

    // EventSource 不支持自定义头 演示环境通过查询参数传递令牌
    const source = new EventSource(
      `${API_BASE}/api/runs/${runId}/events?token=${encodeURIComponent(currentToken())}`,
    )

    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)

    const handle = (raw: MessageEvent | Event) => {
      const event = raw as MessageEvent
      if (!event.data) return
      try {
        const parsed = JSON.parse(event.data as string) as AgentEvent
        const reduced = reduceEvent(stateRef.current, parsed)
        stateRef.current = reduced
        setState(reduced)
      } catch {
        // 忽略无法解析的心跳注释
      }
    }

    // 事件名区分监听 使用通配方式逐一注册协议事件
    const eventTypes = [
      'run.started',
      'message.user',
      'message.delta',
      'message.completed',
      'agent.turn',
      'agent.tool_results',
      'tool.input.delta',
      'context.compacted',
      'step.started',
      'step.completed',
      'tool.requested',
      'tool.completed',
      'approval.required',
      'approval.decided',
      'logistics.event',
      'run.paused',
      'run.resumed',
      'run.failed',
      'run.completed',
      'run.escalated',
      'run.handover',
      'operator.message',
      'run.resolved',
    ]
    for (const type of eventTypes) {
      source.addEventListener(type, handle as EventListener)
    }

    return () => {
      source.close()
      setConnected(false)
    }
  }, [runId])

  return { state, connected }
}
