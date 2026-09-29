import { OrderCandidates } from '@aftersales/contracts'

interface Message {
  role: string
  content: Array<Record<string, unknown>>
}
interface Decision {
  name: string
  args: Record<string, unknown>
}

/** 只把用户原文和补问回复作为选择依据 工具中的订单号不能代替用户确认 */
export function orderSelectionDecision(messages: Message[]): Decision {
  const calls = new Map<string, string>()
  const replies: string[] = []
  const results: Array<{ name: string; content: unknown; failed: boolean; replyCount: number }> = []
  for (const message of messages) {
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool_use')
        calls.set(String(block.id), String(block.name))
      if (message.role !== 'user') continue
      if (block.type === 'text') replies.push(String(block.text))
      if (block.type !== 'tool_result') continue
      const name = calls.get(String(block.tool_use_id)) ?? ''
      if (name === 'ask_user') {
        replies.push(String(block.content))
      } else {
        let content: unknown
        try {
          content = JSON.parse(String(block.content))
        } catch {
          content = null
        }
        results.push({ name, content, failed: Boolean(block.is_error), replyCount: replies.length })
      }
    }
  }
  const ask = (question: string, missingSlot: string): Decision => ({
    name: 'ask_user',
    args: { question, missingSlot },
  })
  const escalate = (reason: string): Decision => ({
    name: 'escalate',
    args: { reason, kind: 'customer_request', explanation: reason },
  })
  const text = replies.join(' ')
  const latest = replies.at(-1) ?? ''
  if (/转人工|人工客服|没有我要找的订单/.test(latest)) return escalate('客户需要人工协助定位订单')
  if (/补偿|价保|换货/.test(text)) return escalate('当前演示需要人工核验该业务')
  // 重新选单后丢弃旧订单选择 退货原因仍保留在原始诉求中
  const reset = replies.reduce(
    (found, reply, index) => (/重新选择订单|重新查询订单/.test(reply) ? index : found),
    -1,
  )
  const selections = replies.slice(Math.max(0, reset))
  const selectedText = selections.join(' ')
  const orderNo = [...selectedText.matchAll(/SO-2026-\d{4}/g)].at(-1)?.[0]
  if (!orderNo) {
    const pageResult = [...results].reverse().find((result) => result.name === 'list_my_orders')
    const parsed = OrderCandidates.safeParse(pageResult?.content)
    const page = parsed.success ? parsed.data : undefined
    const refreshed = pageResult?.replyCount === replies.length
    if (!pageResult || (!refreshed && /重新选择订单|重新查询订单/.test(latest)))
      return { name: 'list_my_orders', args: { offset: 0 } }
    if (!refreshed && /查看更多订单/.test(latest) && page?.nextOffset != null)
      return { name: 'list_my_orders', args: { offset: page.nextOffset } }
    if (!page || pageResult.failed)
      return ask('订单查询暂时失败 可以回复重新查询订单 或转人工协助', 'orderNo')
    if (!page.orders.length)
      return ask('当前账号没有查到订单 请确认登录账号 也可以提供订单号或转人工协助', 'orderNo')
    return ask('请从下方订单中选择出现问题的商品 我会保留您刚才描述的诉求', 'orderNo')
  }
  const orderResults = results.filter((result) => result.name === 'get_order')
  const orderResult = [...orderResults].reverse().find((result) => {
    const content = result.content as { orderNo?: string } | null
    return !result.failed && content?.orderNo === orderNo
  })
  if (!orderResult) {
    if (orderResults.at(-1)?.failed && orderResults.at(-1)?.replyCount === replies.length)
      return ask('无法查询这笔订单 请核对账号和订单号 或回复重新选择订单', 'orderNo')
    return { name: 'get_order', args: { orderNo } }
  }
  if (!/退款|退货/.test(text)) return { name: 'conclude', args: { summary: '已完成订单查询' } }
  const reason = /质量|无法开机|不能开机|开不了机|不开机/.test(text)
    ? 'quality'
    : /损坏/.test(text)
      ? 'damaged'
      : /丢件/.test(text)
        ? 'lost_package'
        : /未发货/.test(text)
          ? 'unshipped_cancel'
          : /无理由/.test(text)
            ? 'no_reason'
            : undefined
  if (!reason) return ask('请说明商品出现的问题或退款原因', 'reason')
  const name = /退货/.test(text) ? 'submit_return' : 'submit_refund_only'
  const order = orderResult.content as { items: Array<{ itemId: string }> }
  // 商品选择仅取最后一次选单及其后续回复 避免旧订单商品串入新订单
  const lastOrderIndex = selections.reduce(
    (found, reply, index) => (reply.includes(orderNo) ? index : found),
    -1,
  )
  const itemText = selections.slice(lastOrderIndex).join(' ')
  const requested = [...itemText.matchAll(/\bitem-[\w-]+/g)].map((match) => match[0])
  if (requested.some((itemId) => !order.items.some((item) => item.itemId === itemId)))
    return ask('所选商品不属于这笔订单 请重新选择商品', 'itemIds')
  const itemIds = requested.length
    ? [...new Set(requested)]
    : order.items.length === 1 || /全部商品/.test(itemText)
      ? order.items.map((item) => item.itemId)
      : undefined
  if (name === 'submit_return' && !itemIds)
    return ask('这笔订单包含多件商品 请选择要退的商品或全部商品', 'itemIds')
  if (!results.some((result) => result.name === 'search_policy' && !result.failed)) {
    if (results.at(-1)?.name === 'search_policy' && results.at(-1)?.failed)
      return escalate('政策查询失败 请人工核验')
    return { name: 'search_policy', args: { query: '退款 退货 质量 审批' } }
  }
  if (results.some((result) => result.name === name)) return escalate('原售后申请未受理 请人工核验')
  return {
    name,
    args: {
      orderNo,
      reason,
      ...(name === 'submit_return' ? { itemIds } : {}),
      explanation: '按客户原始诉求和明确选择提交领域核验',
    },
  }
}
