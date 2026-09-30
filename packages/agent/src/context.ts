/**
 * 上下文管理
 *
 * 事件流是唯一事实来源 每轮从事件重建原生消息历史
 * 三段式结构 working memory 状态便签加最近消息加超限压缩
 * 压缩第一档为确定性的工具结果清理 无模型调用 评测不受影响
 * 压缩动作落 context.compacted 事件 前后 token 可量化对比
 */

import type { EventRepository } from '@aftersales/domain'
import { ASK_USER_TOOL } from './tool-defs.js'
import type { ContextBlock, ModelMessage } from './model.js'

/** 近距离保留的完整工具结果数 更早的结果清理为单行摘要 */
const KEEP_FULL_TOOL_RESULTS = 4

/** token 估算系数 中英混排经验值 一字符约 0.4 token */
const CHARS_PER_TOKEN = 2.5

export interface ManagedContext {
  messages: ModelMessage[]
  /** 结构化状态便签 注入系统提示词 */
  workingMemory: string
}

export interface BuildContextOptions {
  eventRepo: EventRepository
  runId: string
  /** token 预算估算值 缺省不压缩 */
  tokenBudget?: number
}

/** 从事件重建原生消息历史 连续 tool_result 合并为单个 user 轮 */
export function rebuildMessages(events: EventRow[]): ModelMessage[] {
  const messages: ModelMessage[] = []
  let pendingResults: ContextBlock[] = []

  // 尚无结果的工具调用 物流推送合成的 user 消息须先以合成 tool_result 配对
  // 否则原生协议里 tool_use 悬空无 tool_result 中转按结构校验会拒绝
  const unansweredCalls = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'agent.turn') {
      const payload = event.payload as { blocks: Array<Record<string, unknown>> }
      for (const raw of payload.blocks) {
        if (raw.type === 'tool_use') {
          unansweredCalls.set(String(raw.toolCallId), String(raw.toolName))
        }
      }
    } else if (event.type === 'agent.tool_results') {
      const payload = event.payload as { results: Array<{ toolCallId: string }> }
      for (const result of payload.results) {
        unansweredCalls.delete(result.toolCallId)
      }
    } else if (event.type === 'message.user') {
      const reply = (event.payload as { replyToToolCallId?: string }).replyToToolCallId
      if (reply) unansweredCalls.delete(reply)
    }
  }

  const flushResults = () => {
    if (pendingResults.length > 0) {
      messages.push({ role: 'user', content: pendingResults })
      pendingResults = []
    }
  }

  // 有真实结果的挂起动作先完成协议配对 再交付其执行期间到达的物流通知
  // 只调整模型消息顺序 原始审计事件和实际发生时间保持不变
  const ordered: EventRow[] = []
  const deferred: EventRow[] = []
  const active = new Set<string>()
  for (const event of events) {
    // 原退款执行期间的补充消息在真实结果之后交付 不生成虚假工具结果
    const businessReply =
      event.type === 'message.user'
        ? (event.payload as { businessToolCallId?: string }).businessToolCallId
        : undefined
    if (businessReply && active.has(businessReply) && !unansweredCalls.has(businessReply)) {
      deferred.push(event)
      continue
    }
    if (event.type === 'logistics.event' && [...active].some((id) => !unansweredCalls.has(id))) {
      deferred.push(event)
      continue
    }
    ordered.push(event)
    if (event.type === 'agent.turn') {
      for (const block of (event.payload as { blocks: Array<Record<string, unknown>> }).blocks)
        if (block.type === 'tool_use') active.add(String(block.toolCallId))
    } else if (event.type === 'agent.tool_results') {
      for (const result of (event.payload as { results: Array<{ toolCallId: string }> }).results)
        active.delete(result.toolCallId)
    } else if (event.type === 'message.user') {
      const reply = (event.payload as { replyToToolCallId?: string }).replyToToolCallId
      if (reply) active.delete(reply)
    }
    if (![...active].some((id) => !unansweredCalls.has(id))) ordered.push(...deferred.splice(0))
  }
  ordered.push(...deferred)
  const seenCalls = new Set<string>()
  for (const event of ordered) {
    if (event.type === 'message.user') {
      flushResults()
      const payload = event.payload as { text: string; replyToToolCallId?: string }
      if (payload.replyToToolCallId) {
        seenCalls.delete(payload.replyToToolCallId)
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolCallId: payload.replyToToolCallId,
              toolName: ASK_USER_TOOL,
              content: payload.text,
              isError: false,
            },
          ],
        })
      } else {
        messages.push({ role: 'user', content: [{ type: 'text', text: payload.text }] })
      }
    } else if (event.type === 'agent.turn') {
      flushResults()
      const payload = event.payload as { blocks: Array<Record<string, unknown>> }
      const blocks: ContextBlock[] = payload.blocks.map((raw) => {
        if (raw.type === 'text') {
          return { type: 'text' as const, text: String(raw.text) }
        }
        seenCalls.add(String(raw.toolCallId))
        return {
          type: 'tool_use' as const,
          toolCallId: String(raw.toolCallId),
          toolName: String(raw.toolName),
          input: (raw.input ?? {}) as Record<string, unknown>,
          ...(Array.isArray(raw.thoughtSignature)
            ? { thoughtSignature: raw.thoughtSignature as number[] }
            : {}),
        }
      })
      messages.push({ role: 'assistant', content: blocks })
    } else if (event.type === 'agent.tool_results') {
      const payload = event.payload as { results: Array<Record<string, unknown>> }
      for (const raw of payload.results) {
        seenCalls.delete(String(raw.toolCallId))
        pendingResults.push({
          type: 'tool_result',
          toolCallId: String(raw.toolCallId),
          toolName: String(raw.toolName),
          content: String(raw.content),
          isError: Boolean(raw.isError),
        })
      }
    } else if (event.type === 'logistics.event') {
      // 物流推送合成 user 消息 模型据此查证最新状态并主动告知客户
      flushResults()
      const payload = event.payload as {
        orderNo?: string
        status?: string
        description?: string
      }
      const statusText =
        payload.status === 'lost'
          ? '包裹丢失'
          : payload.status === 'delayed'
            ? '运输延误'
            : '状态更新'
      const content: ContextBlock[] = []
      // 挂起的调用以合成 tool_result 配对 补问未答时告知模型客户尚未回复
      // 配对后从集合移除 多次推送不重复配对同一调用
      for (const [toolCallId, toolName] of unansweredCalls) {
        if (!seenCalls.has(toolCallId)) continue
        content.push({
          type: 'tool_result',
          toolCallId,
          toolName,
          content:
            toolName === ASK_USER_TOOL
              ? '（客户尚未回复该提问 请优先处理本次物流事件）'
              : '（该调用中断未执行 无需等待结果）',
          isError: false,
        })
        unansweredCalls.delete(toolCallId)
        seenCalls.delete(toolCallId)
      }
      content.push({
        type: 'text',
        text: `[物流事件推送] 订单 ${String(payload.orderNo ?? '')} 物流状态更新为${statusText} ${String(payload.description ?? '')} 请查证最新物流状态并主动告知客户`,
      })
      messages.push({ role: 'user', content })
    }
  }
  flushResults()
  return messages
}

interface EventRow {
  type: string
  payload: unknown
}

/**
 * working memory 状态便签
 *
 * 从工具结果与运行事件确定性归约 当前订单 售后单与已发起动作
 * 让模型每轮冷启动也能立即知道任务进展 不依赖长历史
 */
export function buildWorkingMemory(events: EventRow[]): string {
  const lines: string[] = []
  let lastOrder = ''
  let lastShipment = ''
  const actions: string[] = []

  for (const event of events) {
    if (event.type === 'tool.completed') {
      const payload = event.payload as {
        toolName?: string
        status?: string
        resultSummary?: Record<string, unknown>
      }
      if (payload.status !== 'succeeded' || !payload.resultSummary) continue
      if (payload.toolName === 'get_order') {
        lastOrder = String(payload.resultSummary.orderNo ?? '')
      } else if (payload.toolName === 'get_shipment') {
        lastShipment = String(payload.resultSummary.status ?? '')
      }
    } else if (event.type === 'tool.requested') {
      const payload = event.payload as { toolName?: string }
      if (
        payload.toolName === 'create_return_request' ||
        payload.toolName === 'cancel_return_request'
      ) {
        actions.push(String(payload.toolName))
      }
    }
  }

  if (lastOrder) lines.push(`当前订单 ${lastOrder}`)
  if (lastShipment) lines.push(`物流状态 ${lastShipment}`)
  if (actions.length > 0) lines.push(`已发起动作 ${[...new Set(actions)].join(' ')}`)
  return lines.join('\n')
}

/** token 估算 按消息内容字符数折算 */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') {
        chars += block.text.length
      } else if (block.type === 'tool_use') {
        chars += JSON.stringify(block.input).length + block.toolName.length
      } else {
        chars += block.content.length + block.toolName.length
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * 确定性压缩 工具结果清理
 *
 * 保留最近 KEEP_FULL_TOOL_RESULTS 个 tool_result 完整内容
 * 更早的替换为单行摘要 长对话的 token 占用显著下降且无模型调用
 */
export function clearOldToolResults(messages: ModelMessage[]): ModelMessage[] {
  const toolResultBlocks = messages.flatMap((message) =>
    message.content.filter(
      (block): block is ContextBlock & { type: 'tool_result' } => block.type === 'tool_result',
    ),
  )
  const cutoff = toolResultBlocks[Math.max(0, toolResultBlocks.length - KEEP_FULL_TOOL_RESULTS)]
  if (!cutoff) return messages

  let seenCutoff = false
  return messages.map((message) => ({
    ...message,
    content: message.content.map((block) => {
      if (block.type !== 'tool_result') return block
      if (block === cutoff) {
        seenCutoff = true
        return block
      }
      if (seenCutoff) return block
      return {
        ...block,
        content: `[已清理的早期工具结果 ${block.toolName}]`,
      }
    }),
  }))
}

/** 每轮构建托管上下文 超预算时执行确定性压缩并落事件 */
export async function buildManagedContext(options: BuildContextOptions): Promise<ManagedContext> {
  const events = (await options.eventRepo.listByRun(options.runId)) as unknown as EventRow[]
  const workingMemory = buildWorkingMemory(events)
  let messages = rebuildMessages(events)

  if (options.tokenBudget !== undefined) {
    const before = estimateTokens(messages)
    if (before > options.tokenBudget) {
      messages = clearOldToolResults(messages)
      const after = estimateTokens(messages)
      await options.eventRepo.append(options.runId, 'context.compacted', {
        strategy: 'tool_result_clearing',
        beforeTokens: before,
        afterTokens: after,
      })
    }
  }

  return { messages, workingMemory }
}
