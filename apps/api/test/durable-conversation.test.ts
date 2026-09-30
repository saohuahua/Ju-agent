import { afterEach, describe, expect, it } from 'vitest'
import { ScriptedModel } from '@aftersales/agent'
import { SystemClock } from '@aftersales/domain'
import { composeSystem, conversationDemoOptions, type ComposedSystem } from '@aftersales/runtime'
import { createApp } from '../src/app.js'

const systems: ComposedSystem[] = []
afterEach(async () => {
  for (const system of systems.splice(0)) {
    await system.conversations?.stop()
    system.db.close()
  }
})
const headers = (key: string, token = 'cust-token-1001') => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'Idempotency-Key': key,
})
function fixture(options = conversationDemoOptions()) {
  const system = composeSystem({
    clock: new SystemClock(),
    model: new ScriptedModel([]),
    durableConversation: options,
  })
  systems.push(system)
  return { system, app: createApp({ system, modelAvailable: true }) }
}

describe('正式普通会话持久受理', () => {
  it('确认后的政策检索写入工作台引用审计', async () => {
    const options = conversationDemoOptions()
    const original = options.transport
    // 把确定性查单夹具替换为政策查询 保留原生协议和完整回合校验
    options.transport = (snapshot) => ({
      mode: 'simulation',
      async *stream(body, signal) {
        for await (const value of original(snapshot).stream(body, signal)) {
          const frame = value as {
            type: string
            content_block?: { name?: string }
            delta?: { partial_json?: string }
          }
          if (frame.content_block?.name === 'get_order') frame.content_block.name = 'search_policy'
          if (frame.delta?.partial_json?.includes('orderNo'))
            frame.delta.partial_json = JSON.stringify({ query: '质量问题退货' })
          yield frame
        }
      },
    })
    const { system, app } = fixture(options)
    const response = await app.request('/api/runs', {
      method: 'POST',
      headers: headers('policy'),
      body: JSON.stringify({ message: 'SO-2026-0003' }),
    })
    const { runId } = (await response.json()) as { runId: string }
    await system.conversations!.worker.runOnce()
    const audit = system.db
      .prepare(
        "SELECT detail_json FROM audit_logs WHERE run_id = ? AND action = 'policy_articles_searched'",
      )
      .get(runId) as { detail_json: string }
    expect(JSON.parse(audit.detail_json).articleIds.length).toBeGreaterThan(0)
    expect((await system.runService.get(runId)).status).toBe('completed')
  })
  it('普通会话 Worker 不认领资金管线任务', async () => {
    const { system } = fixture()
    const task = system.durableTasks.accept({
      requestKey: 'other-pipeline',
      customerId: 'C1001',
      kind: 'start',
      config: {
        snapshotId: 'test',
        provider: 'test',
        model: 'test',
        promptVersion: 'test',
        value: {},
      },
      plan: { input: '资金管线', tool: 'refund' },
    })
    expect(await system.conversations!.worker.runOnce()).toBe(false)
    expect(system.durableTasks.get(task.taskId)?.status).toBe('queued')
  })
  it('请求重放复用运行 补问回复也不重复写消息并保持同一配置', async () => {
    const { system, app } = fixture()
    const start = () =>
      app.request('/api/runs', {
        method: 'POST',
        headers: headers('start'),
        body: JSON.stringify({ message: '帮我查询订单' }),
      })
    const first = await start()
    expect(first.status).toBe(202)
    const body = (await first.json()) as { runId: string; taskId: string }
    expect(await (await start()).json()).toMatchObject(body)
    await system.conversations!.worker.runOnce()
    expect((await system.runService.get(body.runId)).status).toBe('awaiting_input')
    const reply = () =>
      app.request(`/api/runs/${body.runId}/messages`, {
        method: 'POST',
        headers: headers('reply'),
        body: JSON.stringify({ message: 'SO-2026-0003' }),
      })
    expect((await reply()).status).toBe(202)
    await system.conversations!.worker.runOnce()
    expect((await system.runService.get(body.runId)).status).toBe('completed')
    expect((await reply()).status).toBe(202)
    const events = await system.eventRepo.listByRun(body.runId)
    expect(events.filter((event) => event.type === 'message.user')).toHaveLength(2)
    expect(events.filter((event) => event.type === 'agent.tool_results')).toHaveLength(1)
    expect(system.modelLedger.rows()).toHaveLength(3)
    expect(
      system.db.prepare('SELECT COUNT(DISTINCT snapshot_version) AS n FROM p7_calls').get(),
    ).toEqual({ n: 1 })
    expect(
      (
        await app.request(`/api/runs/${body.runId}/resume`, {
          method: 'POST',
          headers: headers('old', 'operator-token'),
        })
      ).status,
    ).toBe(409)
  })

  it('同键异参拒绝且缺少请求键不能受理', async () => {
    const { system, app } = fixture()
    const send = (message: string, key: string) =>
      app.request('/api/runs', {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify({ message }),
      })
    expect((await send('原消息', 'key')).status).toBe(202)
    expect((await send('另一消息', 'key')).status).toBe(409)
    expect((await send('缺键', '')).status).toBe(400)
    expect(system.db.prepare('SELECT COUNT(*) AS n FROM p6_commands').get()).toEqual({ n: 1 })
  })

  it('业务操作转人工且不能查询其他客户订单', async () => {
    const { system, app } = fixture()
    const started = (await (
      await app.request('/api/runs', {
        method: 'POST',
        headers: headers('money'),
        body: JSON.stringify({ message: '我要退款' }),
      })
    ).json()) as { runId: string }
    await system.conversations!.worker.runOnce()
    expect((await system.runService.get(started.runId)).status).toBe('escalated')
    expect(system.db.prepare('SELECT COUNT(*) AS n FROM p6_effects').get()).toEqual({ n: 0 })
    const foreign = (await (
      await app.request('/api/runs', {
        method: 'POST',
        headers: headers('foreign'),
        body: JSON.stringify({ message: 'SO-2026-0004' }),
      })
    ).json()) as { runId: string }
    await system.conversations!.worker.runOnce()
    const results = (await system.eventRepo.listByRun(foreign.runId)).filter(
      (event) => event.type === 'agent.tool_results',
    )
    expect(results).toHaveLength(1)
    expect(JSON.stringify(results)).toContain('查询失败')
    expect(JSON.stringify(results)).not.toContain('C1002')
  })
})
