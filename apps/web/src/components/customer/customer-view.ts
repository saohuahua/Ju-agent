import type { AgentEvent, OrderCandidates, RunStatus } from '@/lib/types'

export const TERMINAL_STATUSES: RunStatus[] = ['completed', 'failed', 'cancelled']

/** 选单命令保留后台标识 客户气泡只展示可核对的订单与商品 */
export function customerMessageText(text: string, events: AgentEvent[]): string {
  const selected = /^选择订单 (SO-\d{4}-\d{4}) 商品 (item-[\w-]+)$/u.exec(text)
  if (!selected) return text
  const [, orderNo, itemId] = selected
  const candidates = [...events].reverse().filter((event) => event.type === 'order.candidates')
  for (const event of candidates) {
    const orders = (event.payload as unknown as OrderCandidates).orders
    const item = orders
      ?.find((order) => order.orderNo === orderNo)
      ?.items.find((row) => row.itemId === itemId)
    if (item) return `已选择${item.title}（订单 ${orderNo}）`
  }
  return `已选择商品（订单 ${orderNo}）`
}

export function canSendCustomerMessage(
  runId: string | null,
  status: RunStatus,
  modelAvailable: boolean,
): boolean {
  if (!runId) return modelAvailable
  return status === 'handling_human' || (status === 'awaiting_input' && modelAvailable)
}

export function customerStatus(status: RunStatus): { label: string; next: string } {
  switch (status) {
    case 'created':
    case 'running':
      return { label: '正在处理', next: '正在核对您的问题 请等待处理进度' }
    case 'awaiting_input':
      return { label: '等待补充', next: '请在下方补充所需信息' }
    case 'awaiting_approval':
      return { label: '等待确认', next: '处理方案正在确认 请稍候' }
    case 'escalated':
      return { label: '等待人工', next: '售后专员将接手处理' }
    case 'handling_human':
      return { label: '人工处理中', next: '您可以继续留言 售后专员会在此回复' }
    case 'completed':
      return { label: '已完成', next: '本次服务已结束 您可以评价处理体验' }
    case 'failed':
      return { label: '处理暂停', next: '处理暂时中断 请联系售后团队核实进度' }
    case 'cancelled':
      return { label: '已取消', next: '本次服务已取消' }
  }
}

export function customerError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.name === 'AbortError') return ''
  return fallback
}
