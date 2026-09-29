import type { AgentEvent, RunStatus } from './types'

const EVENT_TYPES = [
  'order.candidates',
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
  'human.requested',
  'tools.catalog_changed',
  'guard.blocked',
]

/**
 * 传输层只负责连接生命周期与事件交付
 * 完成帧主动关闭连接 阻止原生事件源把正常结束当作断线重试
 * 取消后忽略已经排队的旧回调 防止身份与案件切换时旧消息回流
 */
export function subscribeEventStream(
  url: string,
  callbacks: {
    onEvent: (event: AgentEvent) => void
    onConnection: (connected: boolean) => void
    onComplete: (status?: RunStatus) => void
  },
) {
  const source = new EventSource(url)
  let active = true

  source.onopen = () => {
    if (active) callbacks.onConnection(true)
  }
  source.onerror = () => {
    if (active) callbacks.onConnection(false)
  }

  const handle = (event: Event) => {
    if (!active) return
    let parsed: AgentEvent
    try {
      parsed = JSON.parse((event as MessageEvent).data) as AgentEvent
    } catch {
      // 无效数据帧不参与状态归约 等待后续有效事件
      return
    }
    // 仅隔离格式错误 归约异常必须可诊断 不能被当作坏帧静默吞掉
    callbacks.onEvent(parsed)
  }

  for (const type of EVENT_TYPES) source.addEventListener(type, handle)

  source.addEventListener('stream.complete', (event) => {
    if (!active) return
    active = false
    source.close()
    callbacks.onConnection(false)
    // 完成帧携带最终状态以覆盖没有独立取消事件的旧运行
    let status: RunStatus | undefined
    try {
      const payload = JSON.parse((event as MessageEvent).data)
      if (['completed', 'failed', 'cancelled'].includes(payload.status)) status = payload.status
    } catch {
      // 旧服务没有状态字段时保留事件归约结果
    }
    callbacks.onComplete(status)
  })

  // 水位帧只让浏览器推进续传游标 无需加入业务事件列表
  return () => {
    active = false
    source.close()
  }
}
