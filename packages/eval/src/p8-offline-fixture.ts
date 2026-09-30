import type { P8Evidence, P8Mode, P8Role } from '../../contracts/src/p8-investigation.js'
import type { P7Config } from '../../contracts/src/p7-model-gateway.js'
import { P7Error } from '../../contracts/src/p7-model-gateway.js'
import type { P8Investigation } from '../../runtime/src/p8-investigation.js'
import type { P7Transport } from '../../runtime/src/p7-gateway.js'
import { createP7Snapshot } from '../../runtime/src/p7-snapshot.js'
import { conversationDemoOptions } from '../../runtime/src/conversation-demo.js'

export type P8Fault =
  'none' | 'failure' | 'timeout' | 'missing-usage' | 'conflict' | 'foreign-ref' | 'money-tool'
export interface P8FixtureOptions {
  fault?: P8Fault
  faultRole?: P8Role
  delayMs?: number
  onStart?(role: P8Role, body: Record<string, unknown>, signal: AbortSignal): void
}

/** 仅按输入原文返回固定结构 无网络 无外层重试 无推理质量分数 */
export function p8OfflineTransport(role: P8Role, options: P8FixtureOptions = {}): P7Transport {
  return {
    mode: 'simulation',
    async *stream(body, signal) {
      options.onStart?.(role, body, signal)
      const fault = role === (options.faultRole ?? 'policy') ? (options.fault ?? 'none') : 'none'
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      if (fault === 'timeout') await new Promise((resolve) => setTimeout(resolve, 150))
      if (fault === 'failure') throw new P7Error('PROTOCOL')
      const messages = body.messages as Array<{ content: Array<{ text: string }> }>
      const input = JSON.parse(messages[0]!.content[0]!.text) as { evidence: P8Evidence[] }
      const facts = input.evidence.map((item) => ({
        key:
          item.kind === 'policy' ? `policy.${String(item.data.articleId)}` : `${item.kind}.status`,
        value: String(item.kind === 'policy' ? item.data.content : item.data.status),
        ref: item.ref,
      }))
      if (fault === 'conflict' && facts[0]) facts[0].value = '模型伪造的签收事实'
      if (fault === 'foreign-ref' && facts[0]) facts[0].ref = '另一个客户订单的引用'
      const text = JSON.stringify({
        facts,
        citations: input.evidence.map((item) => item.ref),
        unresolved: [],
      })
      yield {
        type: 'message_start',
        message: { usage: fault === 'missing-usage' ? {} : { input_tokens: 10, output_tokens: 0 } },
      }
      if (fault === 'money-tool') {
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'forbidden', name: 'execute_refund', input: {} },
        }
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        }
      } else {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
      }
      yield { type: 'content_block_stop', index: 0 }
      yield {
        type: 'message_delta',
        delta: { stop_reason: fault === 'money-tool' ? 'tool_use' : 'end_turn' },
        usage: fault === 'missing-usage' ? {} : { output_tokens: 5 },
      }
      yield { type: 'message_stop' }
    },
  }
}

/** 两种模式使用同一份业务快照和人工价格 repeat 不作失败重试 */
export async function p8FixtureInput(
  runtime: P8Investigation,
  mode: P8Mode = 'parallel',
  caseId = 'lost-package',
  config: Partial<P7Config> = {},
) {
  const captured = await runtime.capture('C1001', 'SO-2026-0002')
  const { version: _version, ...base } = conversationDemoOptions().snapshot
  const snapshot = createP7Snapshot({
    ...base,
    model: 'p8-deterministic-v1',
    promptVersion: 'p8-analysis-v1',
    toolVersion: 'p8-readonly-v1',
    knowledgeSnapshotId: captured.knowledgeVersion,
    price: {
      ...base.price!,
      version: 'p8-synthetic-fixed-v1',
      fixedMicroPerCall: 10,
      source: 'P8 synthetic fixture',
    },
    timeoutMs: 1000,
    ...config,
  })
  return {
    ...captured,
    experimentId: 'p8-offline-v1',
    caseId,
    repeat: 1,
    mode,
    snapshot,
    userStatements: ['我尚未收到商品 请核验丢件退款条件'],
    acceptedAt: Date.now(),
  }
}
