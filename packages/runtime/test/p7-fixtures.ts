import { createP7Snapshot } from '../src/p7-snapshot.js'
import type { P7Config } from '../../contracts/src/p7-model-gateway.js'
import type { ModelRequest } from '../../agent/src/model.js'

/** 人工价格只验证算法 不代表任何供应商报价 */
export function config(overrides: Partial<P7Config> = {}): P7Config {
  return {
    schemaVersion: 1,
    mode: 'simulation',
    provider: 'fixture',
    model: 'fixture-v1',
    protocol: 'anthropic_messages',
    endpointRef: 'offline',
    credentialRef: 'none',
    promptVersion: 'prompt-v1',
    knowledgeSnapshotId: 'knowledge-v1',
    toolVersion: 'tools-v1',
    budgetRef: 'first-real-cny-100',
    capabilities: {
      tools: true,
      parallelTools: true,
      streamedArguments: true,
      structuredOutput: false,
      cancellation: true,
      usage: 'optional',
      contextTokens: 1000,
      maxOutputTokens: 100,
    },
    price: {
      version: 'synthetic-v1',
      currency: 'CNY',
      inputMicroPerMillion: 1000000,
      outputMicroPerMillion: 2000000,
      fixedMicroPerCall: 0,
      fxNumerator: 1,
      fxDenominator: 1,
      source: 'synthetic fixture',
      fxSource: 'identity',
      verifiedAt: '2026-09-25',
    },
    timeoutMs: 200,
    maxAttempts: 1,
    maxConcurrency: 4,
    maxOutputTokens: 100,
    ...overrides,
  }
}
export const snapshot = () => createP7Snapshot(config())
export const request: ModelRequest = {
  system: '售后测试',
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  tools: [
    {
      name: 'lookup',
      description: '查询',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    },
  ],
}

/** 原生事件夹具保留两个协议各自的分片和结束语义 */
export function frames(
  protocol: P7Config['protocol'],
  options: {
    tools?: number
    text?: string
    json?: readonly string[]
    toolName?: string
    duplicate?: boolean
    idPrefix?: string
    missingUsage?: boolean
    truncated?: boolean
  } = {},
): unknown[] {
  const count = options.tools ?? 0
  const text = options.text ?? (count ? '' : '你好')
  const fragments = options.json ?? ['{"id":', '"O1"}']
  if (protocol === 'anthropic_messages') {
    const result: unknown[] = [
      {
        type: 'message_start',
        message: { usage: options.missingUsage ? {} : { input_tokens: 10, output_tokens: 0 } },
      },
    ]
    if (text)
      result.push(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
      )
    for (let i = 0; i < count; i++) {
      const index = i + 1
      result.push(
        {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: `${options.idPrefix ?? 't'}${options.duplicate ? 0 : i}`,
            name: options.toolName ?? 'lookup',
            input: {},
          },
        },
        ...fragments.map((partial_json) => ({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json },
        })),
        { type: 'content_block_stop', index },
      )
    }
    result.push(
      {
        type: 'message_delta',
        delta: { stop_reason: options.truncated ? 'max_tokens' : count ? 'tool_use' : 'end_turn' },
        usage: options.missingUsage ? {} : { output_tokens: 5 },
      },
      { type: 'message_stop' },
    )
    return result
  }
  const result: unknown[] = []
  if (text) result.push({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
  for (let i = 0; i < count; i++) {
    result.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: i,
                id: `${options.idPrefix ?? 't'}${options.duplicate ? 0 : i}`,
                type: 'function',
                function: { name: options.toolName ?? 'lookup', arguments: fragments[0] },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })
    for (const fragment of fragments.slice(1))
      result.push({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: i, function: { arguments: fragment } }] },
            finish_reason: null,
          },
        ],
      })
  }
  result.push({
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: options.truncated ? 'length' : count ? 'tool_calls' : 'stop',
      },
    ],
  })
  if (!options.missingUsage)
    result.push({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })
  return result
}

export async function* streamFrames(values: unknown[]): AsyncIterable<unknown> {
  yield* values
}
