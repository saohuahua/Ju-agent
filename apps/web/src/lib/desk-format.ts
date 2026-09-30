/** 工作台时间只在展示层本地化而存储时间仍使用标准时间 */
export function deskTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 需关注代表需要人员判断而不等同于所有这些任务都已失败 */
export const ATTENTION_STATUSES = new Set([
  'awaiting_approval',
  'escalated',
  'handling_human',
  'failed',
])

/** 订单状态只作本地化展示 未识别的新状态保留原值便于排查 */
export function orderStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    paid: '已付款 待发货',
    shipped: '已发货',
    delivered: '已签收',
    completed: '已完成',
    cancelled: '已取消',
  }

  return labels[status] ?? status
}
