/**
 * 决策轨迹时间轴的事件投影
 *
 * 把一次 run 的原始事件流投影为「泳道 x 时间」的节点模型：
 * 每个节点归属一条泳道（用户 / 模型 / 工具 / 系统 / 人工），
 * 横向位置按节点序均匀分布——不用墙钟时间轴 因为事件间隔极不均匀
 * （模型思考数十秒 工具执行数毫秒）按时间定位会让密集段挤成一团。
 *
 * 纯函数 不依赖 React 与网络 便于单元测试与时间旅行回放（功能 29）复用。
 */

import type { AgentEvent } from './types'

/** 泳道定义 顺序即渲染顺序 */
export const LANES = ['user', 'model', 'tool', 'system', 'human'] as const
export type Lane = (typeof LANES)[number]

export const LANE_LABEL: Record<Lane, string> = {
  user: '用户',
  model: '模型',
  tool: '工具',
  system: '系统',
  human: '人工',
}

/** 节点的大类 决定配色与图标语义 */
export type NodeKind =
  | 'user-message'
  | 'logistics'
  | 'model-text'
  | 'model-turn'
  | 'tool-call'
  | 'tool-result'
  | 'catalog'
  | 'guard'
  | 'approval'
  | 'context'
  | 'run-lifecycle'
  | 'human-action'

export interface TimelineNode {
  /** 唯一键 用事件序号 */
  key: string
  lane: Lane
  kind: NodeKind
  /** 展示标签 如工具名或一句话摘要 */
  label: string
  /** 横向位置 0 到 1 */
  x: number
  /** 关联的原始事件 详情抽屉按此取完整 payload */
  events: AgentEvent[]
  /** 工具节点配对信息 tool.requested 到 tool.completed 的耗时 */
  latencyMs?: number
  status?: 'succeeded' | 'failed' | 'pending'
  /** 流式入参逐帧原文 由 tool.input.delta 拼接 详情抽屉展示 */
  inputFrames?: string[]
}

/** 事件到泳道的映射 不产生节点的事件返回 null */
function laneOf(event: AgentEvent): Lane | null {
  switch (event.type) {
    case 'message.user':
    case 'logistics.event':
      return 'user'
    case 'message.delta':
    case 'message.completed':
    case 'agent.turn':
      return 'model'
    case 'tool.requested':
    case 'tool.completed':
    case 'tool.input.delta':
    case 'agent.tool_results':
      return 'tool'
    case 'run.handover':
    case 'operator.message':
    case 'run.resolved':
      return 'human'
    case 'tools.catalog_changed':
    case 'guard.blocked':
    case 'approval.required':
    case 'approval.decided':
    case 'context.compacted':
    case 'run.started':
    case 'run.paused':
    case 'run.resumed':
    case 'run.failed':
    case 'run.completed':
    case 'run.escalated':
    case 'step.started':
    case 'step.completed':
      return 'system'
    default:
      return null
  }
}

/** 事件的大类 */
function kindOf(event: AgentEvent): NodeKind {
  switch (event.type) {
    case 'message.user':
      return 'user-message'
    case 'logistics.event':
      return 'logistics'
    case 'message.delta':
    case 'message.completed':
      return 'model-text'
    case 'agent.turn':
      return 'model-turn'
    case 'tool.requested':
    case 'tool.input.delta':
      return 'tool-call'
    case 'tool.completed':
    case 'agent.tool_results':
      return 'tool-result'
    case 'tools.catalog_changed':
      return 'catalog'
    case 'guard.blocked':
      return 'guard'
    case 'approval.required':
    case 'approval.decided':
      return 'approval'
    case 'context.compacted':
      return 'context'
    case 'run.handover':
    case 'operator.message':
    case 'run.resolved':
      return 'human-action'
    default:
      return 'run-lifecycle'
  }
}

/** 节点标签 从 payload 提取最可读的一句话 */
function labelOf(event: AgentEvent): string {
  const payload = event.payload
  switch (event.type) {
    case 'message.user':
      return String(payload.text ?? '').slice(0, 24)
    case 'logistics.event':
      return payload.status === 'lost' ? '物流丢件' : '物流延误'
    case 'message.completed':
      return String(payload.text ?? '').slice(0, 24)
    case 'agent.turn':
      return `轮次 ${String(payload.stopReason ?? '')}`
    case 'tool.requested':
      return String(payload.toolName ?? '')
    case 'tool.completed':
      return String(payload.toolName ?? '')
    case 'tool.input.delta':
      return String(payload.toolName ?? '')
    case 'agent.tool_results':
      return '结果回灌'
    case 'tools.catalog_changed': {
      const gated = (payload.gated as string[] | undefined) ?? []
      return gated.length > 0 ? `门控 ${gated.length} 个动作工具` : '动作工具解禁'
    }
    case 'guard.blocked':
      return `${String(payload.layer ?? '')} 拦截`
    case 'approval.required':
      return '需要审批'
    case 'approval.decided':
      return `审批${payload.decision === 'approved' ? '通过' : payload.decision === 'rejected' ? '拒绝' : '过期'}`
    case 'context.compacted':
      return `压缩 ${String(payload.beforeTokens ?? '?')}→${String(payload.afterTokens ?? '?')}`
    case 'run.started':
      return '运行开始'
    case 'run.paused':
      return payload.reason === 'awaiting_input' ? '等待输入' : '等待审批'
    case 'run.resumed':
      return '恢复运行'
    case 'run.failed':
      return '运行失败'
    case 'run.completed':
      return '运行完成'
    case 'run.escalated':
      return '升级人工'
    case 'run.handover':
      return '坐席接管'
    case 'operator.message':
      return '坐席消息'
    case 'run.resolved':
      return '标记解决'
    case 'step.started':
    case 'step.completed':
      return String(payload.stepName ?? payload.stepId ?? '')
    default:
      return event.type
  }
}

/**
 * 把事件流投影为泳道节点
 *
 * 聚合规则
 * - message.delta 全部折叠进其后最近的 message.completed（流式过程在详情里逐帧看）
 * - tool.input.delta 按 toolCallId 归并到对应工具节点 留下逐帧原文
 * - tool.requested 与 tool.completed 按 executionId 配对成一个节点 标注耗时
 * - agent.tool_results 折叠为独立小节点 供查看回灌内容
 */
export function projectTimeline(events: AgentEvent[]): TimelineNode[] {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence)
  const laneEvents = sorted.filter((event) => laneOf(event) !== null)

  // toolCallId → 逐帧入参
  const inputFrames = new Map<string, string[]>()
  for (const event of sorted) {
    if (event.type === 'tool.input.delta') {
      const toolCallId = String(event.payload.toolCallId ?? '')
      const frames = inputFrames.get(toolCallId) ?? []
      frames.push(String(event.payload.partialJson ?? ''))
      inputFrames.set(toolCallId, frames)
    }
  }

  // executionId → 工具节点索引 配对 requested 与 completed
  const nodes: TimelineNode[] = []
  const byExecution = new Map<string, number>()
  // 流式幽灵工具按 toolCallId 先建节点 tool.requested 到达后升级
  const byToolCall = new Map<string, number>()

  for (const event of laneEvents) {
    const lane = laneOf(event)!

    // message.delta 折叠 不产生独立节点
    if (event.type === 'message.delta') {
      const last = nodes[nodes.length - 1]
      if (last && last.kind === 'model-text') {
        last.events.push(event)
      }
      continue
    }

    // 流式工具参数 归并到已有节点或新建 pending 节点
    if (event.type === 'tool.input.delta') {
      const toolCallId = String(event.payload.toolCallId ?? '')
      const existing = byToolCall.get(toolCallId)
      if (existing !== undefined) {
        nodes[existing]!.events.push(event)
        continue
      }
      const node: TimelineNode = {
        key: `seq-${event.sequence}`,
        lane,
        kind: kindOf(event),
        label: labelOf(event),
        x: 0,
        events: [event],
        status: 'pending',
        inputFrames: inputFrames.get(toolCallId) ?? [],
      }
      byToolCall.set(toolCallId, nodes.length)
      nodes.push(node)
      continue
    }

    if (event.type === 'tool.requested') {
      const executionId = String(event.payload.executionId ?? '')
      const node: TimelineNode = {
        key: `seq-${event.sequence}`,
        lane,
        kind: kindOf(event),
        label: labelOf(event),
        x: 0,
        events: [event],
        status: 'pending',
      }
      byExecution.set(executionId, nodes.length)
      nodes.push(node)
      continue
    }

    if (event.type === 'tool.completed') {
      const executionId = String(event.payload.executionId ?? '')
      const existing = byExecution.get(executionId)
      if (existing !== undefined) {
        const node = nodes[existing]!
        node.events.push(event)
        node.latencyMs = Number(event.payload.latencyMs ?? 0)
        node.status = event.payload.status === 'succeeded' ? 'succeeded' : 'failed'
        continue
      }
    }

    // message.completed 吸收紧邻的 agent.turn（同一轮次的文本与块）
    if (event.type === 'message.completed') {
      const last = nodes[nodes.length - 1]
      if (last && last.kind === 'model-turn' && last.lane === 'model') {
        last.events.push(event)
        last.label = labelOf(event)
        last.kind = 'model-text'
        continue
      }
    }

    nodes.push({
      key: `seq-${event.sequence}`,
      lane,
      kind: kindOf(event),
      label: labelOf(event),
      x: 0,
      events: [event],
    })
  }

  // 均匀横向定位 留出首尾边距避免节点溢出泳道
  const count = nodes.length
  nodes.forEach((node, index) => {
    node.x = count <= 1 ? 0.5 : index / (count - 1)
  })
  return nodes
}
