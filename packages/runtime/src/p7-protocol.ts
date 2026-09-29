import type { ModelRequest, ModelStreamEvent } from '../../agent/src/model.js'
import { P7Error, P7Usage, type P7Snapshot } from '../../contracts/src/p7-model-gateway.js'

type RecordValue = Record<string, unknown>
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new P7Error('PROTOCOL')
  return value as RecordValue
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new P7Error('PROTOCOL')
  return value
}
function index(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new P7Error('PROTOCOL')
  return Number(value)
}

/** 工具结果必须对应上一轮声明 严格阻止重复和伪造配对 */
export function validateP7Request(request: ModelRequest, snapshot: P7Snapshot): void {
  const names = new Set(request.tools.map((t) => t.name))
  if (names.size !== request.tools.length || (names.size > 0 && !snapshot.capabilities.tools))
    throw new P7Error('PROTOCOL')
  const pending = new Map<string, string>()
  const used = new Set<string>()
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        if (
          message.role !== 'assistant' ||
          used.has(block.toolCallId) ||
          !names.has(block.toolName)
        )
          throw new P7Error('PROTOCOL')
        used.add(block.toolCallId)
        pending.set(block.toolCallId, block.toolName)
      } else if (block.type === 'tool_result') {
        if (message.role !== 'user' || pending.get(block.toolCallId) !== block.toolName)
          throw new P7Error('PROTOCOL')
        pending.delete(block.toolCallId)
      } else if (pending.size && message.role === 'user') {
        throw new P7Error('PROTOCOL')
      }
    }
    if (message.role === 'user' && pending.size) throw new P7Error('PROTOCOL')
  }
  if (pending.size) throw new P7Error('PROTOCOL')
  if (
    request.maxTokens !== undefined &&
    (!Number.isInteger(request.maxTokens) ||
      request.maxTokens < 1 ||
      request.maxTokens > snapshot.maxOutputTokens)
  )
    throw new P7Error('CONFIG')
}

/** 两种线协议共用原有消息契约 不迁移业务循环 */
export function encodeP7Request(request: ModelRequest, snapshot: P7Snapshot): RecordValue {
  validateP7Request(request, snapshot)
  const common = {
    model: snapshot.model,
    stream: true,
    max_tokens: request.maxTokens ?? snapshot.maxOutputTokens,
  }
  if (snapshot.protocol === 'anthropic_messages') {
    return {
      ...common,
      system: request.system,
      tools: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content.map((b) =>
          b.type === 'text'
            ? b
            : b.type === 'tool_use'
              ? { type: 'tool_use', id: b.toolCallId, name: b.toolName, input: b.input }
              : {
                  type: 'tool_result',
                  tool_use_id: b.toolCallId,
                  content: b.content,
                  is_error: b.isError,
                },
        ),
      })),
    }
  }
  return {
    ...common,
    stream_options: { include_usage: true },
    tools: request.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
    messages: [
      { role: 'system', content: request.system },
      ...request.messages.flatMap((m) => {
        const results = m.content.filter((b) => b.type === 'tool_result')
        const calls = m.content.filter((b) => b.type === 'tool_use')
        const text = m.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('')
        return [
          ...results.map((b) => ({ role: 'tool', tool_call_id: b.toolCallId, content: b.content })),
          ...(text || calls.length
            ? [
                {
                  role: m.role,
                  content: text || null,
                  ...(calls.length
                    ? {
                        tool_calls: calls.map((b) => ({
                          id: b.toolCallId,
                          type: 'function',
                          function: { name: b.toolName, arguments: JSON.stringify(b.input) },
                          ...(b.thoughtSignature
                            ? {
                                extra_content: {
                                  google: {
                                    thought_signature: Buffer.from(b.thoughtSignature).toString('utf8'),
                                  },
                                },
                              }
                            : {}),
                        })),
                      }
                    : {}),
                },
              ]
            : []),
        ]
      }),
    ],
  }
}

export interface P7ProtocolResult {
  events: ModelStreamEvent[]
  usage: P7Usage | null
  stopReason: 'end_turn' | 'tool_use'
}

/** 接受已解码的提供商事件 网络和凭据由后续传输层负责 */
export async function decodeP7Stream(
  source: AsyncIterable<unknown>,
  request: ModelRequest,
  snapshot: P7Snapshot,
  onUsage: (usage: P7Usage | null) => void,
): Promise<P7ProtocolResult> {
  const tools = new Map<
    number,
    { id: string; name: string; json: string; thoughtSignature?: number[] }
  >()
  const closedBlocks = new Set<number>()
  const blocks = new Set<number>()
  let text = ''
  let stopped = false
  let reason = ''
  let usage: P7Usage | null = null
  let inputTokens: unknown
  let cacheUnsupported = false
  let started = false
  let size = 0
  let usageSeen = false

  function updateUsage(input: unknown, output: unknown): void {
    const parsed = P7Usage.safeParse({ inputTokens: input, outputTokens: output })
    usage = parsed.success && !cacheUnsupported ? parsed.data : null
    onUsage(usage)
  }

  for await (const raw of source) {
    // 限制模拟和将来真实响应的内存占用 异常时账本仍保留未知费用
    size += JSON.stringify(raw).length
    if (size > 8000000) throw new P7Error('PROTOCOL')
    const event = object(raw)
    if (event.error || event.type === 'error') throw new P7Error('UPSTREAM')
    if (snapshot.protocol === 'anthropic_messages') {
      if (stopped) throw new P7Error('PROTOCOL')
      if (!started && event.type !== 'message_start' && event.type !== 'ping')
        throw new P7Error('PROTOCOL')
      if (event.type === 'message_start') {
        if (started) throw new P7Error('PROTOCOL')
        started = true
        const initial = object(object(event.message).usage ?? {})
        inputTokens = initial.input_tokens
        cacheUnsupported =
          (initial.cache_creation_input_tokens !== undefined &&
            initial.cache_creation_input_tokens !== 0) ||
          (initial.cache_read_input_tokens !== undefined && initial.cache_read_input_tokens !== 0)
      } else if (event.type === 'content_block_start') {
        const i = index(event.index)
        if (blocks.has(i) || reason) throw new P7Error('PROTOCOL')
        blocks.add(i)
        const block = object(event.content_block)
        if (block.type === 'tool_use') {
          const initial = object(block.input ?? {})
          tools.set(i, {
            id: string(block.id),
            name: string(block.name),
            json: Object.keys(initial).length ? JSON.stringify(initial) : '',
          })
        } else if (block.type === 'text') text += string(block.text)
        else throw new P7Error('PROTOCOL')
      } else if (event.type === 'content_block_delta') {
        const i = index(event.index)
        if (!blocks.has(i) || closedBlocks.has(i) || reason) throw new P7Error('PROTOCOL')
        const delta = object(event.delta)
        if (delta.type === 'text_delta' && !tools.has(i)) text += string(delta.text)
        else if (
          delta.type === 'input_json_delta' &&
          tools.has(i) &&
          snapshot.capabilities.streamedArguments
        )
          tools.get(i)!.json += string(delta.partial_json)
        else throw new P7Error('PROTOCOL')
      } else if (event.type === 'content_block_stop') {
        const i = index(event.index)
        if (!blocks.has(i) || closedBlocks.has(i)) throw new P7Error('PROTOCOL')
        closedBlocks.add(i)
      } else if (event.type === 'message_delta') {
        if (reason) throw new P7Error('PROTOCOL')
        reason = string(object(event.delta).stop_reason)
        updateUsage(inputTokens, object(event.usage ?? {}).output_tokens)
      } else if (event.type === 'message_stop') {
        if (!started || blocks.size !== closedBlocks.size || !reason) throw new P7Error('PROTOCOL')
        stopped = true
      } else if (event.type !== 'ping') throw new P7Error('PROTOCOL')
    } else {
      if (event.usage) {
        if (usageSeen) {
          onUsage(null)
          throw new P7Error('PROTOCOL')
        }
        usageSeen = true
        const u = object(event.usage)
        updateUsage(u.prompt_tokens, u.completion_tokens)
      }
      if (!Array.isArray(event.choices) || event.choices.length > 1) throw new P7Error('PROTOCOL')
      for (const rawChoice of event.choices) {
        if (stopped) throw new P7Error('PROTOCOL')
        const choice = object(rawChoice)
        if (choice.index !== 0) throw new P7Error('PROTOCOL')
        const delta = object(choice.delta)
        if (delta.content !== undefined && delta.content !== null) text += string(delta.content)
        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls)) throw new P7Error('PROTOCOL')
          for (const rawCall of delta.tool_calls) {
            const call = object(rawCall)
            const i = index(call.index)
            const fn = object(call.function ?? {})
            if (
              tools.has(i) &&
              fn.arguments !== undefined &&
              !snapshot.capabilities.streamedArguments
            )
              throw new P7Error('PROTOCOL')
            if (!tools.has(i)) tools.set(i, { id: string(call.id), name: '', json: '' })
            const target = tools.get(i)!
            if (call.id !== undefined && call.id !== target.id) throw new P7Error('PROTOCOL')
            if (fn.name !== undefined) target.name += string(fn.name)
            if (fn.arguments !== undefined) target.json += string(fn.arguments)
            if (call.extra_content !== undefined) {
              const extra = object(call.extra_content)
              if (extra.google !== undefined) {
                const google = object(extra.google)
                if (google.thought_signature !== undefined) {
                  const signature = string(google.thought_signature)
                  if (!signature || signature.length > 65536) throw new P7Error('PROTOCOL')
                  target.thoughtSignature = [...Buffer.from(signature, 'utf8')]
                }
              }
            }
          }
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          reason = string(choice.finish_reason)
          stopped = true
        }
      }
    }
  }
  if (!stopped) throw new P7Error('CONNECTION')
  if (reason === 'length' || reason === 'max_tokens') throw new P7Error('TRUNCATED')
  if (!['stop', 'end_turn', 'tool_calls', 'tool_use'].includes(reason))
    throw new P7Error('PROTOCOL')
  if (!text.trim() && !tools.size) throw new P7Error('EMPTY')
  if (tools.size > 1 && !snapshot.capabilities.parallelTools) throw new P7Error('PROTOCOL')
  if (tools.size > 0 !== ['tool_calls', 'tool_use'].includes(reason)) throw new P7Error('PROTOCOL')
  const events: ModelStreamEvent[] = text ? [{ type: 'text_delta', text }] : []
  const ids = new Set(
    request.messages.flatMap((m) =>
      m.content.flatMap((b) => (b.type === 'tool_use' ? [b.toolCallId] : [])),
    ),
  )
  for (const tool of tools.values()) {
    if (!tool.id || ids.has(tool.id) || !request.tools.some((t) => t.name === tool.name))
      throw new P7Error('PROTOCOL')
    ids.add(tool.id)
    try {
      object(JSON.parse(tool.json || '{}'))
    } catch {
      throw new P7Error('PROTOCOL')
    }
    events.push(
      {
        type: 'tool_call_start',
        toolCallId: tool.id,
        toolName: tool.name,
        ...(tool.thoughtSignature ? { thoughtSignature: tool.thoughtSignature } : {}),
      },
      { type: 'tool_input_delta', toolCallId: tool.id, partialJson: tool.json || '{}' },
    )
  }
  return { events, usage, stopReason: tools.size ? 'tool_use' : 'end_turn' }
}
