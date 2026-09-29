import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { P7Error, type P7Snapshot } from '@aftersales/contracts'
import { P7Ledger, type SqliteDatabase } from '@aftersales/persistence'
import { createLiveTransport, createP7Snapshot, P7Gateway } from '@aftersales/runtime'

const price = z.number().finite().min(0.000001).max(100000)

export const ModelSettingsInput = z
  .object({
    protocol: z.enum(['anthropic_messages', 'openai_chat']),
    baseUrl: z.string().trim().url().max(500),
    model: z.string().trim().min(1).max(120),
    apiKey: z.string().trim().max(500).optional(),
    inputCnyPerMillion: price,
    outputCnyPerMillion: price,
  })
  .strict()

export type ModelSettingsInput = z.infer<typeof ModelSettingsInput>
type ResolvedSettings = ModelSettingsInput & { baseUrl: string; apiKey: string }

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function baseUrl(value: string): string {
  const url = new URL(value)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new P7Error('CONFIG')
  return url.toString().replace(/\/$/, '')
}

export function localModelOrigin(origin?: string): boolean {
  if (!origin) return true
  try {
    const url = new URL(origin)
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

export class ModelSettingsStore {
  readonly localToken: string
  private active?: { settings: ResolvedSettings; snapshot: P7Snapshot }
  private readonly credentials = new Map<string, ResolvedSettings>()
  private lastTested?: string

  constructor(
    private readonly db: SqliteDatabase,
    private readonly baseSnapshot: P7Snapshot,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    localToken?: string,
  ) {
    this.localToken = localToken?.trim() || randomBytes(24).toString('hex')
  }

  authorized(token?: string): boolean {
    if (!token) return false
    const actual = Buffer.from(token)
    const expected = Buffer.from(this.localToken)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  usesEnvironmentKey(): boolean {
    const settings = this.active?.settings
    if (!settings) return false
    const key =
      settings.protocol === 'anthropic_messages'
        ? this.environment.ANTHROPIC_API_KEY
        : this.environment.OPENAI_API_KEY
    return Boolean(key && key === settings.apiKey)
  }

  status() {
    const settings = this.active?.settings
    const fallbackProtocol =
      this.environment.MODEL_PROTOCOL === 'openai_chat' ||
      (this.environment.MODEL_PROTOCOL !== 'anthropic_messages' &&
        this.environment.OPENAI_API_KEY &&
        !this.environment.ANTHROPIC_API_KEY)
        ? 'openai_chat'
        : 'anthropic_messages'
    const protocol = settings?.protocol ?? fallbackProtocol
    return {
      enabled: Boolean(this.active),
      protocol,
      baseUrl:
        settings?.baseUrl ??
        (protocol === 'anthropic_messages'
          ? this.environment.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
          : this.environment.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
      model:
        settings?.model ??
        (protocol === 'anthropic_messages'
          ? (this.environment.ANTHROPIC_MODEL ?? '')
          : (this.environment.OPENAI_MODEL ?? '')),
      keyConfigured: Boolean(
        settings?.apiKey ||
          (protocol === 'anthropic_messages'
            ? this.environment.ANTHROPIC_API_KEY
            : this.environment.OPENAI_API_KEY),
      ),
      inputCnyPerMillion:
        settings?.inputCnyPerMillion ?? this.environmentPrice('MODEL_INPUT_CNY_PER_MILLION'),
      outputCnyPerMillion:
        settings?.outputCnyPerMillion ?? this.environmentPrice('MODEL_OUTPUT_CNY_PER_MILLION'),
    }
  }

  private environmentPrice(key: string): number | null {
    const value = this.environment[key]
    if (!value) return null
    const parsed = Number(value)
    return price.safeParse(parsed).success ? parsed : null
  }

  private resolve(input: unknown): ResolvedSettings {
    const parsed = ModelSettingsInput.parse(input)
    const apiKey =
      parsed.apiKey ||
      (this.active?.settings.protocol === parsed.protocol ? this.active.settings.apiKey : '') ||
      (parsed.protocol === 'anthropic_messages'
        ? this.environment.ANTHROPIC_API_KEY
        : this.environment.OPENAI_API_KEY)
    if (!apiKey) throw new P7Error('CONFIG')
    return { ...parsed, apiKey, baseUrl: baseUrl(parsed.baseUrl) }
  }

  private snapshot(settings: ResolvedSettings, maxOutputTokens: number): P7Snapshot {
    const { version: _version, ...base } = this.baseSnapshot
    void _version
    return createP7Snapshot({
      ...base,
      mode: 'live',
      provider:
        settings.protocol === 'anthropic_messages' ? 'anthropic-compatible' : 'openai-compatible',
      model: settings.model,
      protocol: settings.protocol,
      endpointRef: `runtime-${hash(settings.baseUrl).slice(0, 16)}`,
      credentialRef: `runtime-${randomUUID()}`,
      capabilities: {
        ...base.capabilities,
        parallelTools: false,
        usage: 'required',
        contextTokens: 8000,
        maxOutputTokens: 512,
      },
      price: {
        version: `user-estimate-${hash([settings.inputCnyPerMillion, settings.outputCnyPerMillion]).slice(0, 16)}`,
        currency: 'CNY',
        inputMicroPerMillion: Math.round(settings.inputCnyPerMillion * 1000000),
        outputMicroPerMillion: Math.round(settings.outputCnyPerMillion * 1000000),
        fixedMicroPerCall: 0,
        fxNumerator: 1,
        fxDenominator: 1,
        source: 'user-provided-estimate',
        fxSource: 'identity',
        verifiedAt: 'unverified',
      },
      timeoutMs: 60000,
      maxAttempts: 1,
      maxConcurrency: 1,
      maxOutputTokens,
    })
  }

  async test(input: unknown): Promise<{ latencyMs: number; reply: string }> {
    const settings = this.resolve(input)
    const outputTokens =
      settings.protocol === 'openai_chat' &&
      new URL(settings.baseUrl).hostname === 'generativelanguage.googleapis.com'
        ? 256
        : 32
    const snapshot = this.snapshot(settings, outputTokens)
    const gateway = new P7Gateway(snapshot, new P7Ledger(this.db))
    const model = gateway.chatModel(
      `model-test-${randomUUID()}`,
      'main_agent',
      createLiveTransport(settings),
    )
    const started = Date.now()
    let reply = ''
    for await (const event of model.stream({
      system: '你是连接测试助手',
      messages: [{ role: 'user', content: [{ type: 'text', text: '请回复连接成功' }] }],
      tools: [],
      maxTokens: outputTokens,
    })) {
      if (event.type === 'text_delta') reply += event.text
    }
    if (!reply.trim()) throw new P7Error('EMPTY')
    this.lastTested = hash(settings)
    return { latencyMs: Date.now() - started, reply: reply.slice(0, 120) }
  }

  enable(input: unknown): ReturnType<ModelSettingsStore['status']> {
    const settings = this.resolve(input)
    if (this.lastTested !== hash(settings)) throw new P7Error('CONFIG')
    const snapshot = this.snapshot(settings, 512)
    this.credentials.set(snapshot.version, settings)
    this.active = { settings, snapshot }
    this.lastTested = undefined
    return this.status()
  }

  enableEnvironment(): ReturnType<ModelSettingsStore['status']> {
    const configured = this.status()
    const settings = this.resolve({
      protocol: configured.protocol,
      baseUrl: configured.baseUrl,
      model: configured.model,
      inputCnyPerMillion: configured.inputCnyPerMillion,
      outputCnyPerMillion: configured.outputCnyPerMillion,
    })
    const snapshot = this.snapshot(settings, 512)
    this.credentials.set(snapshot.version, settings)
    this.active = { settings, snapshot }
    return this.status()
  }

  disable(): ReturnType<ModelSettingsStore['status']> {
    this.active = undefined
    this.credentials.clear()
    this.lastTested = undefined
    return this.status()
  }

  liveSnapshot(): P7Snapshot {
    if (!this.active) throw new P7Error('CONFIG')
    return this.active.snapshot
  }

  transport(snapshot: P7Snapshot) {
    const settings = this.credentials.get(snapshot.version)
    if (!settings) throw new P7Error('CONFIG')
    return createLiveTransport(settings)
  }

  isLiveRun(runId: string): boolean {
    const row = this.db
      .prepare(
        'SELECT input_json AS input FROM p6_commands WHERE run_id = ? ORDER BY rowid LIMIT 1',
      )
      .get(runId) as { input: string } | undefined
    if (!row) return false
    const input = JSON.parse(row.input) as { config?: { value?: { mode?: string } } }
    return input.config?.value?.mode === 'live'
  }
}
