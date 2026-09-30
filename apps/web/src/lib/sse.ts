'use client'

import { useEffect, useState } from 'react'
import { API_BASE } from './api'
import { subscribeEventStream } from './event-stream'
import { initialViewState, reduceEvent, type RunViewState } from './runReducer'
import type { AgentEvent } from './types'
import { useIdentity } from './identity'

export interface SseSession {
  state: RunViewState
  connected: boolean
  complete: boolean
  events: AgentEvent[]
}

const emptySession = (): SseSession => ({
  state: initialViewState(),
  connected: false,
  complete: false,
  events: [],
})

/**
 * 每次订阅拥有独立归约状态 身份或案件变化立即返回空视图
 * 清理连接后旧回调不能更新新会话 原序号去重保证重放不重复
 * 只有收到服务端完成帧才停止重连 单独的业务终态事件不截断尾部消息
 */
export function useRunEvents(runId: string | null): SseSession {
  const { token } = useIdentity()
  const key = `${token}:${runId ?? ''}`
  const [session, setSession] = useState<{ key: string; value: SseSession }>(() => ({
    key,
    value: emptySession(),
  }))

  useEffect(() => {
    let value = emptySession()
    const publish = () => setSession({ key, value })
    publish()

    if (!runId) return

    return subscribeEventStream(
      `${API_BASE}/api/runs/${encodeURIComponent(runId)}/events?token=${encodeURIComponent(token)}`,
      {
        onEvent: (event) => {
          if (event.runId !== runId || event.sequence <= value.state.lastSequence) return
          value = {
            ...value,
            state: reduceEvent(value.state, event),
            events: [...value.events, event],
          }
          publish()
        },
        onConnection: (connected) => {
          value = { ...value, connected }
          publish()
        },
        onComplete: (status) => {
          value = {
            ...value,
            complete: true,
            state: status ? { ...value.state, status } : value.state,
          }
          publish()
        },
      },
    )
  }, [key, runId, token])

  return session.key === key ? session.value : emptySession()
}
