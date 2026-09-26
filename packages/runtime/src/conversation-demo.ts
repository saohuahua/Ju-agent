import { createP7Snapshot } from './p7-snapshot.js'
import type { DurableConversationOptions } from './durable-conversation.js'
import { BASELINE_FIXTURE } from '@aftersales/persistence'
import { buildKnowledgeSnapshot, POLICY_VERSION } from '@aftersales/domain'

/**
 * 可恢复的无密钥演示传输 只依据已持久化消息选择固定响应
 * 不使用进程内递增脚本游标 因此重启不会重置对话进度
 * 零价为显式模拟价格 不代表任何真实供应商报价
 */
export function conversationDemoOptions(refunds = false): DurableConversationOptions {
  const knowledge = buildKnowledgeSnapshot(
    BASELINE_FIXTURE.policyArticles.map((article) => ({
      articleId: article.article_id,
      title: article.title,
      content: article.content,
      source: article.source,
      policyVersion: POLICY_VERSION,
      createdAt: '',
    })),
  )
  return {
    snapshot: createP7Snapshot({
      schemaVersion: 1,
      mode: 'simulation',
      provider: 'local-demo',
      model: refunds ? 'durable-refund-demo' : 'durable-readonly-demo',
      protocol: 'anthropic_messages',
      endpointRef: 'offline',
      credentialRef: 'none',
      promptVersion: refunds ? 'durable-refund-v1' : 'durable-readonly-v1',
      knowledgeSnapshotId: knowledge.snapshotId,
      toolVersion: refunds ? 'refund-v1' : 'readonly-v1',
      budgetRef: 'first-real-cny-100',
      capabilities: {
        tools: true,
        parallelTools: false,
        streamedArguments: true,
        structuredOutput: false,
        cancellation: true,
        usage: 'required',
        contextTokens: 8000,
        maxOutputTokens: 1000,
      },
      price: {
        version: 'synthetic-zero-v1',
        currency: 'CNY',
        inputMicroPerMillion: 0,
        outputMicroPerMillion: 0,
        fixedMicroPerCall: 0,
        fxNumerator: 1,
        fxDenominator: 1,
        source: 'synthetic local demo',
        fxSource: 'identity',
        verifiedAt: '2026-09-25',
      },
      timeoutMs: 5000,
      maxAttempts: 1,
      maxConcurrency: 4,
      maxOutputTokens: 1000,
    }),
    transport: () => ({
      mode: 'simulation',
      async *stream(body, signal) {
        signal.throwIfAborted()
        const messages = body.messages as Array<{
          role: string
          content: Array<Record<string, unknown>>
        }>
        const latest = messages.at(-1)?.content ?? []
        const serialized = JSON.stringify(latest)
        const order = serialized.match(/SO-2026-\d{4}/)?.[0]
        const lookupResult = latest.some(
          (block) =>
            block.type === 'tool_result' && String(block.tool_use_id).includes('get_order'),
        )
        let name = lookupResult
          ? 'conclude'
          : /退款|补偿|价保|退货|换货/.test(serialized)
            ? 'escalate'
            : order
              ? 'get_order'
              : 'ask_user'
        let args: Record<string, unknown> =
          name === 'get_order'
            ? { orderNo: order }
            : name === 'ask_user'
              ? { question: '请提供要查询的订单编号', missingSlot: 'orderNo' }
              : name === 'escalate'
                ? {
                    reason: '需要人工处理业务动作',
                    kind: 'customer_request',
                    explanation: '当前持久演示只支持查询',
                  }
                : { summary: '已完成订单查询' }
        // 离线退款示例只选择槽位 金额资格和最终通知仍由持久领域流程决定
        if (refunds) {
          const requestText = messages
            .filter((message) => message.role === 'user')
            .flatMap((message) => message.content)
            .filter((block) => block.type === 'text')
            .map((block) => String(block.text))
            .join(' ')
          const refundOrder = requestText.match(/SO-2026-\d{4}/)?.[0]
          const results = messages
            .flatMap((message) => message.content)
            .filter((block) => block.type === 'tool_result')
          const has = (tool: string) =>
            results.some((block) => String(block.tool_use_id).includes(tool))
          if (/退款|退货/.test(requestText) && !/补偿|价保|换货/.test(requestText)) {
            const action = /退货/.test(requestText) ? 'submit_return' : 'submit_refund_only'
            const reason = /质量/.test(requestText)
              ? 'quality'
              : /损坏/.test(requestText)
                ? 'damaged'
                : /丢件/.test(requestText)
                  ? 'lost_package'
                  : /未发货/.test(requestText)
                    ? 'unshipped_cancel'
                    : /无理由/.test(requestText)
                      ? 'no_reason'
                      : undefined
            name =
              !refundOrder || !reason
                ? 'ask_user'
                : !has('get_order')
                  ? 'get_order'
                  : !has('search_policy')
                    ? 'search_policy'
                    : has(action)
                      ? 'escalate'
                      : action
            args =
              name === 'ask_user'
                ? {
                    question: !refundOrder ? '请提供退款订单编号' : '请说明退款原因',
                    missingSlot: !refundOrder ? 'orderNo' : 'reason',
                  }
                : name === 'get_order'
                  ? { orderNo: refundOrder }
                  : name === 'search_policy'
                    ? { query: '退款 退货 审批' }
                    : name === 'escalate'
                      ? {
                          reason: '原售后申请未受理 请人工核验',
                          kind: 'service_failure',
                          explanation: '业务规则拒绝',
                        }
                      : { orderNo: refundOrder, reason, explanation: '按客户诉求提交领域核验' }
          }
        }
        const text =
          name === 'conclude'
            ? serialized.includes('查询失败')
              ? '订单查询未成功 请核对订单编号后重试'
              : '演示查询已完成 请以订单记录为准'
            : name === 'escalate'
              ? '业务操作需要人工核验 已转交售后专员'
              : ''
        yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }
        if (text) {
          yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
          yield { type: 'content_block_stop', index: 0 }
        }
        yield {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'tool_use',
            id: `demo-${messages.length}-${name}`,
            name,
            input: {},
          },
        }
        yield {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) },
        }
        yield { type: 'content_block_stop', index: 1 }
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 5 },
        }
        yield { type: 'message_stop' }
      },
    }),
  }
}
