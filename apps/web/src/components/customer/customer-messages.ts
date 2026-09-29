import type { ChatMessage, RunViewState } from '@/lib/runReducer'

export interface PendingCustomerMessage {
  requestKey: string
  runId: string | null
  text: string
  delivery: NonNullable<ChatMessage['delivery']>
}

/**
 * 本地消息只在原会话展示 后台请求键确认后以脱敏事件文本为准
 * 旧事件没有请求键时保持原样 不用文本或消息数量猜测确认关系
 * 响应先到或事件先到都使用同一个键 网络未知不会伪装成已受理
 */
export function customerMessages(
  messages: ChatMessage[],
  pending: PendingCustomerMessage[],
  runId: string | null,
): ChatMessage[] {
  const confirmed = new Set(
    messages.flatMap((message) => (message.requestKey ? [message.requestKey] : [])),
  )
  return [
    ...messages,
    ...pending
      .filter((message) => message.runId === runId && !confirmed.has(message.requestKey))
      .map(({ text, requestKey, delivery }) => ({
        role: 'user' as const,
        text,
        requestKey,
        delivery,
      })),
  ]
}

export const DELIVERY_LABELS = {
  sending: '发送中',
  accepted: '已受理 正在同步消息',
  failed: '发送失败 可重试',
  unknown: '发送结果未确认 请重试核实',
}

/** 只有公开动作事件能说明工具进度 连接成功本身不代表模型正在生成 */
export function customerProcessing(state: RunViewState): string {
  if (state.status === 'awaiting_input' && state.consultation === 'ready')
    return '您可以继续提问或结束本次咨询'
  if (state.status === 'awaiting_input')
    return state.orderCandidates ? '等待您选择订单或补充信息' : '等待您补充信息'
  if (state.status === 'failed') return '处理暂时中断'
  if (state.status !== 'running') return ''
  const tool = state.processingTool
  const names: Record<string, string> = {
    list_my_orders: '查询最近订单',
    get_order: '核验订单信息',
    get_shipment: '查询物流',
    search_policy: '检索售后政策',
  }
  const name = tool ? names[tool.toolName] : undefined
  if (!tool || !name) return '已受理 正在处理您的问题'
  if (tool.status === 'pending') return `正在${name}`
  return tool.status === 'succeeded' ? `${name}已完成 正在整理回复` : `${name}未成功 正在处理`
}
