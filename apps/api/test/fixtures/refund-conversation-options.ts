import { conversationDemoOptions } from '@aftersales/runtime'
import type { DurableConversationOptions } from '../../../../packages/runtime/src/durable-conversation.js'
import { createP7Snapshot } from '../../../../packages/runtime/src/p7-snapshot.js'
import { frames } from '../../../../packages/runtime/test/p7-fixtures.js'

/** 确定性离线协议按持久上下文选择响应 不依赖进程内游标 */
export function refundConversationOptions(
  action = 'submit_refund_only',
  reason = 'unshipped_cancel',
): DurableConversationOptions {
  const original = conversationDemoOptions().snapshot
  const { version: _version, ...config } = original
  return {
    snapshot: createP7Snapshot({
      ...config,
      model: 'refund-offline-fixture',
      promptVersion: 'refund-fixture-v1',
      toolVersion: 'refund-v1',
      price: { ...original.price!, fixedMicroPerCall: 10 },
      timeoutMs: 5000,
    }),
    leaseMs: 1500,
    transport: () => ({
      mode: 'simulation',
      async *stream(body, signal) {
        signal.throwIfAborted()
        const messages = body.messages as Array<{
          role: string
          content: Array<Record<string, unknown>>
        }>
        const serialized = JSON.stringify(messages)
        const orderNo = serialized.match(/SO-2026-\d{4}/)?.[0]
        const results = messages
          .flatMap((message) => message.content)
          .filter((block) => block.type === 'tool_result')
        const has = (name: string) =>
          results.some((block) => String(block.tool_use_id).includes(name))
        const toolName = !orderNo
          ? 'ask_user'
          : !has('get_order')
            ? 'get_order'
            : !has('search_policy')
              ? 'search_policy'
              : has(action)
                ? 'escalate'
                : action
        const input =
          toolName === 'ask_user'
            ? { question: '请提供退款订单编号', missingSlot: 'orderNo' }
            : toolName === 'get_order'
              ? { orderNo }
              : toolName === 'search_policy'
                ? { query: '退款 退货 质量 大额审批' }
                : toolName === 'escalate'
                  ? {
                      reason: '申请未受理 请人工核验原售后',
                      kind: 'service_failure',
                      explanation: '领域拒绝',
                    }
                  : { orderNo, reason, explanation: '离线协议提出申请 金额与授权由领域核验' }
        for (const frame of frames('anthropic_messages', {
          tools: 1,
          toolName,
          idPrefix: `refund-${messages.length}-${toolName}`,
          json: [JSON.stringify(input)],
          text: toolName === action ? '模型声称退款成功不能作为资金事实' : '',
        }))
          yield frame
      },
    }),
  }
}
