import { afterEach, expect, it } from 'vitest'
import { ScriptedModel, rebuildMessages } from '@aftersales/agent'
import { FrozenClock } from '@aftersales/domain'
import { EVENT_PAYLOAD_SCHEMAS } from '@aftersales/contracts'
import { composeSystem, conversationDemoOptions, type ComposedSystem } from '@aftersales/runtime'
import { createApp } from '../src/app.js'
import {
  fixedCustomerReply,
  requestsHuman,
} from '../../../packages/runtime/src/customer-guidance.js'

const systems: ComposedSystem[] = []
afterEach(() => systems.splice(0).forEach((system) => system.db.close()))

/** 协议替身只验证持久边界和工具配对 不作为真实模型质量证据 */
function setup(tool?: 'conclude' | 'ask_user') {
  const options = conversationDemoOptions(true, true)
  let calls = 0
  if (tool)
    options.transport = () => ({
      mode: 'simulation',
      async *stream() {
        calls++
        yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: `test-${calls}`, name: tool, input: {} },
        }
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(
              tool === 'conclude'
                ? { summary: '已根据记录答复' }
                : { question: '请说明需要哪种售后帮助', missingSlot: 'intent' },
            ),
          },
        }
        yield { type: 'content_block_stop', index: 0 }
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 8 },
        }
        yield { type: 'message_stop' }
      },
    })
  const system = composeSystem({
    clock: new FrozenClock('2026-09-20T12:00:00Z'),
    model: new ScriptedModel([]),
    durableConversation: options,
    durableBusiness: { snapshot: options.snapshot, paymentUrl: 'http://127.0.0.1:1' },
  })
  systems.push(system)
  const app = createApp({ system, modelAvailable: false })
  let seq = 0
  const request = (path: string, body: unknown, key = `key-${++seq}`, token = 'cust-token-1001') =>
    app.request(path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    })
  const send = async (message: string, runId?: string) => {
    const response = await request(runId ? `/api/runs/${runId}/messages` : '/api/runs', { message })
    expect(response.status).toBe(202)
    const result = (await response.json()) as { runId: string }
    await system.conversations!.worker.runOnce()
    return result.runId
  }
  return {
    system,
    app,
    request,
    send,
    calls: () => calls,
    events: (id: string) => system.conversations!.journal.events(id),
  }
}

it('固定问候不查单不调用模型且保留上下文 连续追问后可显式结案', async () => {
  const f = setup('conclude')
  const id = await f.send('你好')
  expect(f.calls()).toBe(0)
  expect(f.events(id).some((event) => event.type === 'order.candidates')).toBe(false)
  expect(rebuildMessages(f.events(id))).toHaveLength(2)
  await f.send('我想了解运费的规则', id)
  await f.send('还能进一步说明吗', id)
  expect(f.calls()).toBe(2)
  expect((await f.system.runService.get(id)).status).toBe('awaiting_input')
  const history = rebuildMessages(f.events(id))
  expect(
    history.flatMap((message) => message.content).filter((block) => block.type === 'tool_result'),
  ).toHaveLength(2)
  const body = { message: '结束咨询', action: 'end_consultation' }
  expect((await f.request(`/api/runs/${id}/messages`, body, 'close')).status).toBe(202)
  const size = f.events(id).length
  expect((await f.request(`/api/runs/${id}/messages`, body, 'close')).status).toBe(202)
  expect(f.events(id)).toHaveLength(size)
  expect((await f.system.runService.get(id)).status).toBe('completed')
  expect((await f.request(`/api/runs/${id}/messages`, { message: '继续' })).status).toBe(409)
})

it('连续意图补问展示业务选项 待补问回复不会被固定话术截断', async () => {
  const f = setup('ask_user')
  const id = await f.send('有点问题')
  await f.send('你好', id)
  expect(f.calls()).toBe(2)
  expect(
    f
      .events(id)
      .filter((event) => event.type === 'run.paused')
      .at(-1)?.payload,
  ).toMatchObject({ consultation: 'clarify', showChoices: true })
})

it('复合诉求和否定转人工不命中快捷规则', () => {
  expect(fixedCustomerReply('你好 我想退货', false)).toBeUndefined()
  expect(requestsHuman('不用转人工')).toBe(false)
  expect(requestsHuman('怎么联系人工')).toBe(false)
  expect(requestsHuman('请转人工')).toBe(true)
})

it('模型不可用仍可幂等申请人工 坐席接管回复和结案复用原接口', async () => {
  const f = setup()
  const response = await f.request('/api/human-help', {}, 'human')
  expect(response.status).toBe(202)
  const { runId } = (await response.json()) as { runId: string }
  const size = f.events(runId).length
  for (const event of f.events(runId)) {
    const schema = EVENT_PAYLOAD_SCHEMAS[event.type as keyof typeof EVENT_PAYLOAD_SCHEMAS]
    expect(schema.safeParse(event.payload).success).toBe(true)
  }
  expect(await (await f.request('/api/human-help', {}, 'human')).json()).toMatchObject({ runId })
  expect(await (await f.request('/api/human-help', {}, 'another-key')).json()).toMatchObject({
    runId,
  })
  expect(f.events(runId)).toHaveLength(size)
  expect(
    (await f.request(`/api/runs/${runId}/handover`, {}, 'take', 'operator-token')).status,
  ).toBe(200)
  expect(
    (
      await f.request(
        `/api/runs/${runId}/operator-messages`,
        { message: '您好 请描述问题' },
        'reply',
        'operator-token',
      )
    ).status,
  ).toBe(200)
  expect(
    (await f.request(`/api/runs/${runId}/messages`, { message: '我收到的商品损坏了' })).status,
  ).toBe(200)
  expect(
    (
      await f.request(
        `/api/runs/${runId}/resolve`,
        { summary: '已说明售后步骤' },
        'resolve',
        'operator-token',
      )
    ).status,
  ).toBe(200)
  expect(
    f.system.db.prepare("SELECT COUNT(*) AS n FROM p6_tasks WHERE status = 'queued'").get(),
  ).toEqual({ n: 0 })
})

it('空闲咨询原会话转接 拒绝跨客户请求和同键异参', async () => {
  const f = setup()
  const id = await f.send('你好')
  expect(
    (await f.request('/api/human-help', { sourceRunId: id }, 'other', 'cust-token-1002')).status,
  ).toBe(403)
  expect(
    await (await f.request('/api/human-help', { sourceRunId: id }, 'same')).json(),
  ).toMatchObject({ runId: id })
  expect((await f.request('/api/human-help', {}, 'same')).status).toBe(409)
  expect((await f.system.runService.get(id)).status).toBe('escalated')
})

it('运行中与已失败会话另开关联人工 原任务保持原状', async () => {
  const f = setup()
  const response = await f.request('/api/runs', { message: '查询订单物流' })
  const { runId } = (await response.json()) as { runId: string }
  const before = f.system.db.prepare('SELECT * FROM p6_tasks WHERE run_id = ?').all(runId)
  const human = (await (await f.request('/api/human-help', { sourceRunId: runId })).json()) as {
    runId: string
  }
  expect(human.runId).not.toBe(runId)
  expect(f.system.db.prepare('SELECT * FROM p6_tasks WHERE run_id = ?').all(runId)).toEqual(before)
  expect(f.events(human.runId)).toContainEqual({
    type: 'human.requested',
    payload: { sourceRunId: runId },
  })
  expect(await (await f.request('/api/human-help', { sourceRunId: runId })).json()).toMatchObject(
    human,
  )
  f.system.db.prepare("UPDATE agent_runs SET status = 'failed' WHERE run_id = ?").run(runId)
  expect(await (await f.request('/api/human-help', { sourceRunId: runId })).json()).toMatchObject(
    human,
  )
})

it('已受理退款另开人工且拒绝结束 原业务关联和执行权不改变', async () => {
  const f = setup()
  const id = await f.send('商品无法开机 我要退货 SO-2026-0003')
  const before = f.system.db
    .prepare('SELECT * FROM p6_conversation_refunds WHERE run_id = ?')
    .all(id)
  expect(before).toHaveLength(1)
  const ownership = f.system.db.prepare('SELECT * FROM execution_ownership').all()
  const result = (await (await f.request('/api/human-help', { sourceRunId: id })).json()) as {
    runId: string
  }
  expect(result.runId).not.toBe(id)
  expect(
    (
      await f.request(`/api/runs/${id}/messages`, {
        message: '结束咨询',
        action: 'end_consultation',
      })
    ).status,
  ).toBe(409)
  expect(
    f.system.db.prepare('SELECT * FROM p6_conversation_refunds WHERE run_id = ?').all(id),
  ).toEqual(before)
  expect(f.system.db.prepare('SELECT * FROM execution_ownership').all()).toEqual(ownership)
  const typed = await f.request(`/api/runs/${id}/messages`, { message: '请转人工' })
  expect(typed.status).toBe(202)
  expect(await typed.json()).toMatchObject(result)
})
