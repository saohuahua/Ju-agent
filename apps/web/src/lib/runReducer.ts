/**
 * 事件归约器
 *
 * 工作台的核心状态逻辑 把 SSE 事件流归约为视图状态
 * 纯函数设计 刷新重连与回放共用同一条路径 不依赖内存残留
 */

import type { AgentEvent, RunStatus } from './types'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  text: string
  /** 助手消息是否仍在流式拼接 */
  streaming?: boolean
}

export interface ToolItem {
  /** 工具调用标识 流式阶段为 pending 前缀 执行阶段替换为 executionId */
  executionId: string
  /** 模型侧工具调用 id 用于流式期与执行期关联 */
  toolCallId?: string
  toolName: string
  attempt: number
  status: 'pending' | 'succeeded' | 'failed'
  /** 工具参数是否仍在流式生成 */
  inputStreaming?: boolean
  /** 已累积的工具参数 JSON 片段 */
  inputJson?: string
  errorCode?: string
  latencyMs?: number
  resultSummary?: Record<string, unknown>
}

export interface ApprovalItem {
  approvalId: string
  resourceId: string
  amountCents: number
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
}

export interface RunViewState {
  status: RunStatus
  connected: boolean
  messages: ChatMessage[]
  tools: ToolItem[]
  approvals: ApprovalItem[]
  steps: Array<{ stepId: string; stepName: string; outcome: string }>
  /** 上下文压缩次数 上下文工程的可视化证据 */
  contextCompactions: number
  error: string | null
  lastSequence: number
}

export function initialViewState(): RunViewState {
  return {
    status: 'created',
    connected: false,
    messages: [],
    tools: [],
    approvals: [],
    steps: [],
    contextCompactions: 0,
    error: null,
    lastSequence: 0,
  }
}

/** 单事件归约 返回新状态 事件序号必须单调推进 */
export function reduceEvent(state: RunViewState, event: AgentEvent): RunViewState {
  if (event.sequence <= state.lastSequence) {
    return state
  }
  const next: RunViewState = { ...state, lastSequence: event.sequence }
  const payload = event.payload as Record<string, unknown>

  switch (event.type) {
    case 'run.started': {
      next.status = 'running'
      return next
    }
    case 'message.user': {
      next.messages = [...state.messages, { role: 'user', text: String(payload.text ?? '') }]
      return next
    }
    case 'message.delta': {
      const last = state.messages[state.messages.length - 1]
      // 流式片段续接到未完结的助手消息上
      if (last?.role === 'assistant' && last.streaming) {
        next.messages = [
          ...state.messages.slice(0, -1),
          { ...last, text: last.text + String(payload.textDelta ?? '') },
        ]
      } else {
        next.messages = [
          ...state.messages,
          { role: 'assistant', text: String(payload.textDelta ?? ''), streaming: true },
        ]
      }
      return next
    }
    case 'message.completed': {
      const last = state.messages[state.messages.length - 1]
      const text = String(payload.text ?? '')
      if (last?.role === 'assistant' && last.streaming) {
        // 完整消息以 completed 为准 覆盖拼接结果
        next.messages = [
          ...state.messages.slice(0, -1),
          { role: 'assistant', text, streaming: false },
        ]
      } else {
        next.messages = [...state.messages, { role: 'assistant', text, streaming: false }]
      }
      return next
    }
    case 'step.started': {
      next.steps = [
        ...state.steps,
        { stepId: String(payload.stepId), stepName: String(payload.stepName), outcome: 'running' },
      ]
      return next
    }
    case 'step.completed': {
      next.steps = state.steps.map((step, index) =>
        index === state.steps.length - 1 && step.stepId === String(payload.stepId)
          ? { ...step, outcome: String(payload.outcome) }
          : step,
      )
      return next
    }
    case 'tool.input.delta': {
      // 模型正在流式生成工具参数 按 toolCallId 累积渐进展示
      const toolCallId = String(payload.toolCallId ?? '')
      const existing = state.tools.find((tool) => tool.toolCallId === toolCallId)
      if (existing) {
        next.tools = state.tools.map((tool) =>
          tool.toolCallId === toolCallId
            ? {
                ...tool,
                inputJson: (tool.inputJson ?? '') + String(payload.partialJson ?? ''),
              }
            : tool,
        )
      } else {
        next.tools = [
          ...state.tools,
          {
            executionId: `pending-${toolCallId}`,
            toolCallId,
            toolName: String(payload.toolName ?? ''),
            attempt: 1,
            status: 'pending',
            inputStreaming: true,
            inputJson: String(payload.partialJson ?? ''),
          },
        ]
      }
      return next
    }
    case 'context.compacted': {
      next.contextCompactions = state.contextCompactions + 1
      return next
    }
    case 'tool.requested': {
      const toolName = String(payload.toolName)
      // 流式期的幽灵条目按工具名关联 升级为执行条目
      const ghost = state.tools.find(
        (tool) =>
          tool.inputStreaming && tool.toolName === toolName && tool.executionId.startsWith('pending-'),
      )
      if (ghost) {
        next.tools = state.tools.map((tool) =>
          tool === ghost
            ? {
                ...tool,
                executionId: String(payload.executionId),
                attempt: Number(payload.attempt ?? 1),
                inputStreaming: false,
              }
            : tool,
        )
        return next
      }
      next.tools = [
        ...state.tools,
        {
          executionId: String(payload.executionId),
          toolName,
          attempt: Number(payload.attempt ?? 1),
          status: 'pending',
        },
      ]
      return next
    }
    case 'tool.completed': {
      const summary = payload.resultSummary as Record<string, unknown> | undefined
      next.tools = state.tools.map((tool) =>
        tool.executionId === String(payload.executionId)
          ? {
              ...tool,
              status: payload.status === 'succeeded' ? 'succeeded' : 'failed',
              errorCode: payload.errorCode ? String(payload.errorCode) : undefined,
              latencyMs: Number(payload.latencyMs ?? 0),
              resultSummary: summary,
            }
          : tool,
      )
      return next
    }
    case 'approval.required': {
      next.approvals = [
        ...state.approvals,
        {
          approvalId: String(payload.approvalId),
          resourceId: String(payload.resourceId),
          amountCents: Number(payload.amountCents ?? 0),
          reason: String(payload.reason ?? ''),
          status: 'pending',
        },
      ]
      return next
    }
    case 'approval.decided': {
      const decision = String(payload.decision ?? '') as ApprovalItem['status']
      next.approvals = state.approvals.map((approval) =>
        approval.approvalId === String(payload.approvalId)
          ? { ...approval, status: decision }
          : approval,
      )
      return next
    }
    case 'run.paused': {
      next.status = payload.reason === 'awaiting_input' ? 'awaiting_input' : 'awaiting_approval'
      return next
    }
    case 'run.resumed': {
      next.status = 'running'
      return next
    }
    case 'run.failed': {
      next.status = 'failed'
      next.error = String(payload.message ?? '运行失败')
      return next
    }
    case 'run.escalated': {
      next.status = 'escalated'
      return next
    }
    case 'run.completed': {
      next.status = 'completed'
      return next
    }
    default: {
      // agent.turn agent.tool_results 等内部事件不影响视图状态
      return next
    }
  }
}

/** 批量归约 重建历史时间线 */
export function reduceEvents(state: RunViewState, events: AgentEvent[]): RunViewState {
  let current = state
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    current = reduceEvent(current, event)
  }
  return current
}

/** 分转元的展示辅助 千分位分隔 如 ¥6,999.00 */
export function formatAmount(cents: number, currency = 'CNY'): string {
  const symbol = currency === 'CNY' ? '¥' : ''
  const [integer, decimal] = (cents / 100).toFixed(2).split('.')
  const grouped = integer!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${symbol}${grouped}.${decimal}`
}
