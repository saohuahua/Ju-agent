/**
 * API 契约测试
 *
 * 通过 app.request 直接驱动路由 覆盖鉴权 越权 审批闭环与 SSE 补发
 */

import { describe, expect, it } from 'vitest'
import { ScriptedModel } from '@aftersales/agent'
import type { AgentOutput } from '@aftersales/contracts'
import { FrozenClock } from '@aftersales/domain'
import { composeSystem } from '@aftersales/runtime'
import { createApp } from '../src/app.js'
import { createAuthEnv } from '../src/auth.js'

const CUSTOMER_TOKEN = 'cust-token-1001'
const CUSTOMER2_TOKEN = 'cust-token-1002'
const authEnv = createAuthEnv()

function makeApp(script: AgentOutput[]) {
  const system = composeSystem({
    clock: new FrozenClock('2026-09-20T12:00:00.000Z'),
    model: new ScriptedModel(script),
  })
  const app = createApp({ system, authEnv, modelAvailable: true })
  return { app, system }
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

describe('基础契约', () => {
  it('健康检查返回模型可用状态', async () => {
    const { app } = makeApp([])
    const response = await app.request('/api/health', { headers: auth(CUSTOMER_TOKEN) })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { status: string }
    expect(body.status).toBe('ok')
  })

  it('缺少令牌返回 401', async () => {
    const { app } = makeApp([])
    const response = await app.request('/api/runs')
    expect(response.status).toBe(401)
  })

  it('无效令牌返回 401', async () => {
    const { app } = makeApp([])
    const response = await app.request('/api/runs', { headers: auth('bad-token') })
    expect(response.status).toBe(401)
  })

  it('模型不可用时创建运行返回 503', async () => {
    const { app } = makeApp([])
    const appNoModel = createApp({
      system: composeSystem({
        clock: new FrozenClock('2026-09-20T12:00:00.000Z'),
        model: new ScriptedModel([]),
      }),
      authEnv,
      modelAvailable: false,
    })
    const response = await appNoModel.request('/api/runs', {
      method: 'POST',
      headers: { ...auth(CUSTOMER_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好' }),
    })
    expect(response.status).toBe(503)
    expect(app).toBeDefined()
  })
})

describe('运行与会话', () => {
  it('客户创建运行完成查单 客户只能看自己的会话', async () => {
    const script: AgentOutput[] = [
      { kind: 'tool_call', tool: 'get_order', args: { orderNo: 'SO-2026-0002' }, reason: '查单' },
      { kind: 'final', answer: '订单在运输中', escalated: false, summary: '查单' },
    ]
    const { app } = makeApp(script)
    const create = await app.request('/api/runs', {
      method: 'POST',
      headers: { ...auth(CUSTOMER_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '订单 SO-2026-0002 到哪了' }),
    })
    expect(create.status).toBe(201)
    const created = (await create.json()) as { runId: string; outcome: string }
    expect(created.outcome).toBe('completed')

    // 本人可见
    const own = await app.request(`/api/runs/${created.runId}`, { headers: auth(CUSTOMER_TOKEN) })
    expect(own.status).toBe(200)
    // 他人不可见
    const other = await app.request(`/api/runs/${created.runId}`, {
      headers: auth(CUSTOMER2_TOKEN),
    })
    expect(other.status).toBe(403)
    // 操作员可见
    const operatorView = await app.request(`/api/runs/${created.runId}`, {
      headers: auth(authEnv.operatorToken),
    })
    expect(operatorView.status).toBe(200)
  })

  it('事件 JSON 端点返回完整时间线', async () => {
    const script: AgentOutput[] = [
      { kind: 'final', answer: '您好 请问有什么可以帮您', escalated: false, summary: '问候' },
    ]
    const { app } = makeApp(script)
    const create = await app.request('/api/runs', {
      method: 'POST',
      headers: { ...auth(CUSTOMER_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '在吗' }),
    })
    const created = (await create.json()) as { runId: string }
    const eventsResponse = await app.request(`/api/runs/${created.runId}/events/json`, {
      headers: auth(CUSTOMER_TOKEN),
    })
    const body = (await eventsResponse.json()) as {
      events: Array<{ sequence: number; type: string }>
    }
    const types = body.events.map((e) => e.type)
    expect(types).toContain('run.started')
    expect(types).toContain('message.user')
    expect(types).toContain('run.completed')
    // 序号从 1 开始且连续
    expect(body.events[0]?.sequence).toBe(1)
  })
})

describe('审批闭环', () => {
  it('大额退款走完整审批链路', async () => {
    const script: AgentOutput[] = [
      { kind: 'tool_call', tool: 'get_order', args: { orderNo: 'SO-2026-0001' }, reason: '查单' },
      {
        kind: 'action',
        intent: 'submit_refund_only',
        slots: { orderNo: 'SO-2026-0001', reason: 'unshipped_cancel' },
        reason: '退款',
      },
      { kind: 'final', answer: '审批通过 退款将原路返回', escalated: false, summary: '完成' },
    ]
    const { app } = makeApp(script)

    const create = await app.request('/api/runs', {
      method: 'POST',
      headers: { ...auth(CUSTOMER_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '订单 SO-2026-0001 退款' }),
    })
    const created = (await create.json()) as { runId: string; outcome: string }
    expect(created.outcome).toBe('awaiting_approval')

    // 操作员查看待审批
    const pending = await app.request('/api/approvals', { headers: auth(authEnv.operatorToken) })
    const pendingBody = (await pending.json()) as {
      approvals: Array<{ approvalId: string; runId: string | null }>
    }
    const approval = pendingBody.approvals.find((a) => a.runId === created.runId)
    expect(approval).toBeDefined()

    // 操作员不能决定
    const operatorDecide = await app.request(
      `/api/runs/${created.runId}/approvals/${approval!.approvalId}/decide`,
      {
        method: 'POST',
        headers: { ...auth(authEnv.operatorToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', decidedBy: 'operator' }),
      },
    )
    expect(operatorDecide.status).toBe(403)

    // 主管批准
    const decide = await app.request(
      `/api/runs/${created.runId}/approvals/${approval!.approvalId}/decide`,
      {
        method: 'POST',
        headers: { ...auth(authEnv.supervisorToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', decidedBy: 'supervisor' }),
      },
    )
    expect(decide.status).toBe(200)
    const decided = (await decide.json()) as { outcome: string }
    expect(decided.outcome).toBe('completed')

    // 重复决定被拦截
    const duplicate = await app.request(
      `/api/runs/${created.runId}/approvals/${approval!.approvalId}/decide`,
      {
        method: 'POST',
        headers: { ...auth(authEnv.supervisorToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'rejected', decidedBy: 'supervisor' }),
      },
    )
    expect(duplicate.status).toBe(409)
  })
})

describe('SSE 事件流', () => {
  it('Last-Event-ID 之后的事件被补发', async () => {
    const script: AgentOutput[] = [
      { kind: 'final', answer: '您好', escalated: false, summary: '问候' },
    ]
    const { app } = makeApp(script)
    const create = await app.request('/api/runs', {
      method: 'POST',
      headers: { ...auth(CUSTOMER_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '在吗' }),
    })
    const created = (await create.json()) as { runId: string }

    // 已完成的运行 流会先补发再关闭
    const response = await app.request(`/api/runs/${created.runId}/events`, {
      headers: { ...auth(CUSTOMER_TOKEN), 'Last-Event-ID': '2' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')

    const body = await readStreamUntilComplete(response.body!)
    const ids = parseEventIds(body)
    // 从 3 开始补发 不重复 1 2
    expect(ids[0]).toBe(3)
    expect(ids).toEqual([...new Set(ids)])
    expect(ids.length).toBeGreaterThan(1)
  })
})

/** 读取 SSE 流直到完成标记或超时 */
async function readStreamUntilComplete(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (value) {
      text += decoder.decode(value)
      if (text.includes('stream-complete')) {
        break
      }
    }
    if (done) break
  }
  await reader.cancel()
  return text
}

function parseEventIds(text: string): number[] {
  const ids: number[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('id: ')) {
      ids.push(Number(line.slice(4)))
    }
  }
  return ids
}
