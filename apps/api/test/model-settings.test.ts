import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createMemoryDatabase, initializeDemo, P7Ledger } from '@aftersales/persistence'
import { SystemClock } from '@aftersales/domain'
import { composeSystem, conversationDemoOptions } from '@aftersales/runtime'
import { ModelSettingsStore, localModelOrigin } from '../src/model-settings.js'
import { createApp } from '../src/app.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))))
})

async function provider(protocol: 'anthropic_messages' | 'openai_chat') {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += String(chunk)
    requests.push({ path: request.url ?? '', body: JSON.parse(text) as Record<string, unknown> })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (event: unknown, name?: string) => {
      if (name) response.write(`event: ${name}\n`)
      response.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    if (protocol === 'anthropic_messages') {
      emit(
        { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
        'message_start',
      )
      emit(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        'content_block_start',
      )
      emit(
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '连接成功' } },
        'content_block_delta',
      )
      emit({ type: 'content_block_stop', index: 0 }, 'content_block_stop')
      emit(
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        'message_delta',
      )
      emit({ type: 'message_stop' }, 'message_stop')
    } else {
      emit({ choices: [{ index: 0, delta: { content: '连接成功' }, finish_reason: null }] })
      emit({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      emit({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })
      response.write('data: [DONE]\n\n')
    }
    response.end()
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  return { baseUrl: `http://127.0.0.1:${port}${protocol === 'openai_chat' ? '/v1' : ''}`, requests }
}

it.each(['anthropic_messages', 'openai_chat'] as const)(
  '%s 连接测试验证流式响应和用量后才能启用',
  async (protocol) => {
    const db = createMemoryDatabase()
    try {
      const fake = await provider(protocol)
      const store = new ModelSettingsStore(
        db,
        conversationDemoOptions(true).snapshot,
        {},
        'local-secret',
      )
      const input = {
        protocol,
        baseUrl: fake.baseUrl,
        model: 'mock-model',
        apiKey: 'provider-secret',
        inputCnyPerMillion: 1,
        outputCnyPerMillion: 2,
      }
      expect(() => store.enable(input)).toThrow()
      expect(await store.test(input)).toMatchObject({ reply: '连接成功' })
      expect(store.enable(input)).toMatchObject({ enabled: true, model: 'mock-model' })
      expect(store.authorized('local-secret')).toBe(true)
      expect(store.authorized('wrong')).toBe(false)
      expect(fake.requests).toHaveLength(1)
      expect(fake.requests[0]?.body.model).toBe('mock-model')
      expect(fake.requests[0]?.body.stream).toBe(true)
      expect(store.liveSnapshot().mode).toBe('live')
      expect(JSON.stringify(store.liveSnapshot())).not.toContain('provider-secret')
      expect(JSON.stringify(store.status())).not.toContain('provider-secret')
      expect(new P7Ledger(db).totals('live:first-real-cny-100').committed).toBeGreaterThan(0)
      const savedSnapshot = store.liveSnapshot()
      expect(store.disable().enabled).toBe(false)
      expect(() => store.transport(savedSnapshot)).toThrow('CONFIG')
    } finally {
      db.close()
    }
  },
)

it('管理来源只接受本机地址', () => {
  expect(localModelOrigin('http://127.0.0.1:8790')).toBe(true)
  expect(localModelOrigin('http://localhost:8790')).toBe(true)
  expect(localModelOrigin('http://10.10.12.25:8790')).toBe(false)
})

it('环境变量只预填配置 不自动启用真实模型', () => {
  const db = createMemoryDatabase()
  try {
    const store = new ModelSettingsStore(
      db,
      conversationDemoOptions(true).snapshot,
      {
        MODEL_PROTOCOL: 'openai_chat',
        OPENAI_BASE_URL: 'https://example.com/v1',
        OPENAI_MODEL: 'configured-model',
        OPENAI_API_KEY: 'configured-key',
        MODEL_INPUT_CNY_PER_MILLION: '3.5',
        MODEL_OUTPUT_CNY_PER_MILLION: '12',
      },
      'local-secret',
    )
    expect(store.status()).toMatchObject({
      enabled: false,
      protocol: 'openai_chat',
      baseUrl: 'https://example.com/v1',
      model: 'configured-model',
      keyConfigured: true,
      inputCnyPerMillion: 3.5,
      outputCnyPerMillion: 12,
    })
    expect(JSON.stringify(store.status())).not.toContain('configured-key')
    expect(() => store.liveSnapshot()).toThrow('CONFIG')
  } finally {
    db.close()
  }
})

it('当前协议缺少密钥时不借用另一协议的密钥状态', () => {
  const db = createMemoryDatabase()
  try {
    const store = new ModelSettingsStore(
      db,
      conversationDemoOptions(true).snapshot,
      { MODEL_PROTOCOL: 'anthropic_messages', OPENAI_API_KEY: 'other-key' },
    )
    expect(store.status()).toMatchObject({
      protocol: 'anthropic_messages',
      keyConfigured: false,
    })
  } finally {
    db.close()
  }
})

it('错误密钥不占住后续连接测试的并发槽', async () => {
  const db = createMemoryDatabase()
  const server = createServer(async (request, response) => {
    if (request.headers.authorization === 'Bearer wrong-key') {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'unauthorized' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(
      'data: {"choices":[{"index":0,"delta":{"content":"连接成功"},"finish_reason":null}]}\n\n',
    )
    response.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
    response.write('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n')
    response.end('data: [DONE]\n\n')
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    const store = new ModelSettingsStore(
      db,
      conversationDemoOptions(true).snapshot,
      {},
      'local-secret',
    )
    const base = {
      protocol: 'openai_chat' as const,
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      model: 'mock-model',
      inputCnyPerMillion: 1,
      outputCnyPerMillion: 2,
    }
    await expect(store.test({ ...base, apiKey: 'wrong-key' })).rejects.toMatchObject({
      code: 'CONFIG',
    })
    expect(new P7Ledger(db).totals('live:first-real-cny-100').active).toBe(0)
    await expect(store.test({ ...base, apiKey: 'correct-key' })).resolves.toMatchObject({
      reply: '连接成功',
    })
  } finally {
    db.close()
  }
})

it('HTTP 新会话只在本机持有管理口令时冻结真实模型快照', async () => {
  const db = createMemoryDatabase()
  try {
    initializeDemo(db)
    const demo = conversationDemoOptions(true)
    const store = new ModelSettingsStore(db, demo.snapshot, {}, 'local-secret')
    const fake = await provider('openai_chat')
    const input = {
      protocol: 'openai_chat' as const,
      baseUrl: fake.baseUrl,
      model: 'mock-model',
      apiKey: 'provider-secret',
      inputCnyPerMillion: 1,
      outputCnyPerMillion: 2,
    }
    await store.test(input)
    store.enable(input)
    const system = composeSystem({
      db,
      clock: new SystemClock(),
      model: {
        info: { provider: 'disabled', model: 'disabled' },
        async *stream() {
          yield* []
        },
      },
      withFixture: false,
      durableConversation: {
        ...demo,
        transport: (snapshot) =>
          snapshot.mode === 'live' ? store.transport(snapshot) : demo.transport(snapshot),
      },
    })
    const app = createApp({ system, modelAvailable: false, modelSettings: store })
    const request = (key: string, origin: string, token?: string) =>
      app.request('/api/runs', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer cust-token-1001',
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          Origin: origin,
          ...(token ? { 'X-Model-Local-Token': token } : {}),
        },
        body: JSON.stringify({ message: '你好', modelMode: 'live' }),
      })
    expect((await request('lan', 'http://10.10.12.25:8790', 'local-secret')).status).toBe(403)
    expect((await request('missing', 'http://127.0.0.1:8790')).status).toBe(403)
    const accepted = await request('local', 'http://127.0.0.1:8790', 'local-secret')
    expect(accepted.status).toBe(202)
    const { runId } = (await accepted.json()) as { runId: string }
    expect(store.isLiveRun(runId)).toBe(true)
    const remoteReply = await app.request(`/api/runs/${runId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer cust-token-1001',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'remote-reply',
        Origin: 'http://10.10.12.25:8790',
      },
      body: JSON.stringify({ message: '继续' }),
    })
    expect(remoteReply.status).toBe(403)
    const saved = db
      .prepare('SELECT input_json AS input FROM p6_commands WHERE run_id = ? LIMIT 1')
      .get(runId) as { input: string }
    expect(saved.input).not.toContain('provider-secret')
    const replayAsSimulation = await app.request('/api/runs', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer cust-token-1001',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'local',
      },
      body: JSON.stringify({ message: '你好' }),
    })
    expect(replayAsSimulation.status).toBe(409)
    const status = await app.request('/api/model-settings', {
      headers: { Authorization: 'Bearer supervisor-token' },
    })
    expect(status.status).toBe(200)
    expect(await status.text()).not.toContain('provider-secret')
    system.conversations?.start()
    let responded = false
    for (let attempt = 0; attempt < 40; attempt++) {
      const row = db.prepare('SELECT status FROM agent_runs WHERE run_id = ?').get(runId) as {
        status: string
      }
      if (row.status === 'awaiting_input') {
        responded = true
        break
      }
      await new Promise((done) => setTimeout(done, 50))
    }
    const diagnosis = {
      run: db.prepare('SELECT status FROM agent_runs WHERE run_id = ?').get(runId),
      tasks: db.prepare('SELECT tool,status,error FROM p6_tasks WHERE run_id = ?').all(runId),
      events: db.prepare('SELECT type FROM agent_events WHERE run_id = ?').all(runId),
      calls: db.prepare('SELECT status,outcome FROM p7_calls WHERE run_id = ?').all(runId),
    }
    expect(responded, JSON.stringify(diagnosis)).toBe(true)
    expect(fake.requests).toHaveLength(2)
    expect(
      db
        .prepare(
          "SELECT payload_json AS payload FROM agent_events WHERE run_id = ? AND type = 'message.completed' ORDER BY sequence DESC LIMIT 1",
        )
        .get(runId),
    ).toMatchObject({ payload: expect.stringContaining('连接成功') })
    const followUp = await app.request(`/api/runs/${runId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer cust-token-1001',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'local-reply',
        Origin: 'http://127.0.0.1:8790',
        'X-Model-Local-Token': 'local-secret',
      },
      body: JSON.stringify({ message: '继续' }),
    })
    expect(followUp.status).toBe(202)
    for (let attempt = 0; attempt < 40 && fake.requests.length < 3; attempt++) {
      await new Promise((done) => setTimeout(done, 50))
    }
    await system.conversations?.stop()
    expect(fake.requests).toHaveLength(3)
  } finally {
    db.close()
  }
})
