import { z } from 'zod'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const name = z.string().min(1)

/** 用途只用于归因 所有用途共享同一个累计预算 */
export const P7Purpose = z.enum([
  'main_agent',
  'sub_agent',
  'embedding',
  'rerank',
  'simulator',
  'judge',
])
export type P7Purpose = z.infer<typeof P7Purpose>

/** 能力必须由适配试验确认 不能从兼容路径推断 */
export const P7Capabilities = z
  .object({
    tools: z.boolean(),
    parallelTools: z.boolean(),
    streamedArguments: z.boolean(),
    structuredOutput: z.boolean(),
    cancellation: z.boolean(),
    usage: z.enum(['required', 'optional']),
    contextTokens: integer.positive(),
    maxOutputTokens: integer.positive(),
  })
  .strict()

/** 单价为原币微单位每百万 token 汇率为版本化人民币有理数 */
export const P7Price = z
  .object({
    version: name,
    currency: z.enum(['CNY', 'USD']),
    inputMicroPerMillion: integer,
    outputMicroPerMillion: integer,
    fixedMicroPerCall: integer,
    fxNumerator: integer.positive(),
    fxDenominator: integer.positive(),
    source: name,
    fxSource: name,
    verifiedAt: name,
  })
  .strict()
  .refine((p) => p.currency !== 'CNY' || p.fxNumerator === p.fxDenominator, '人民币无需换汇')
export type P7Price = z.infer<typeof P7Price>

/** 无密钥快照供持久命令保存 所有恢复只能复用原快照 */
export const P7Config = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(['simulation', 'live']),
    provider: name,
    model: name,
    protocol: z.enum(['anthropic_messages', 'openai_chat']),
    endpointRef: name,
    credentialRef: name,
    promptVersion: name,
    knowledgeSnapshotId: name,
    toolVersion: name,
    budgetRef: z.literal('first-real-cny-100'),
    capabilities: P7Capabilities,
    price: P7Price.nullable(),
    timeoutMs: integer.positive().max(300000),
    maxAttempts: integer.positive().max(3),
    maxConcurrency: integer.positive().max(32),
    maxOutputTokens: integer.positive(),
  })
  .strict()
  .refine(
    (c) =>
      c.maxOutputTokens <= c.capabilities.maxOutputTokens &&
      c.maxOutputTokens < c.capabilities.contextTokens,
    '输出上限必须符合模型能力',
  )
export type P7Config = z.infer<typeof P7Config>
export type P7Snapshot = Readonly<P7Config> & { readonly version: string }

export const P7Usage = z.object({ inputTokens: integer, outputTokens: integer }).strict()
export type P7Usage = z.infer<typeof P7Usage>

export type P7ErrorCode =
  | 'PRICE_MISSING'
  | 'USAGE_MISSING'
  | 'BUDGET_EXCEEDED'
  | 'CONCURRENCY'
  | 'PROTOCOL'
  | 'TRUNCATED'
  | 'EMPTY'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'RATE_LIMITED'
  | 'UPSTREAM'
  | 'CONNECTION'
  | 'LIVE_DISABLED'
  | 'CONFIG'

/** 错误不携带原始响应和秘密信息 默认无法证明失败调用免费 */
export class P7Error extends Error {
  constructor(readonly code: P7ErrorCode) {
    super(code)
    this.name = 'P7Error'
  }
}

export interface P7CallIdentity {
  callId: string
  operationId: string
  runId: string
  purpose: P7Purpose
  attempt: number
}
