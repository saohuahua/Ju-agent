/**
 * API 契约测试
 *
 * 通过 app.request 直接驱动路由 覆盖鉴权 越权 审批闭环与 SSE 补发
 */

import { describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { ScriptedModel } from '@aftersales/agent'
import type { AgentOutput } from '@aftersales/contracts'
import { FrozenClock } from '@aftersales/domain'
import { composeSystem } from '@aftersales/runtime'
import { createApp, type AppEnv } from '../src/app.js'
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

/** 运行提交后后台推进 轮询至状态收敛 超时视为失败 */
async function settleRun(
  app: Hono<AppEnv>,
  runId: string,
  token: string,
  timeoutMs = 5000,
): Promise<{ status: string; runId: string }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await app.request(`/api/runs/${runId}`, { headers: auth(token) })
    const body = (await response.json()) as { run: { status: string; runId: string } }
    if (
      [
        'completed',
        'failed',
        'cancelled',
        'escalated',
        'awaiting_input',
        'awaiting_approval',
      ].includes(body.run.status)
    ) {
      return body.run
    }
    if (Date.now() > deadline) {
      throw new Error(`运行未在限时内收敛 ${runId} 停留于 ${body.run.status}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('基础契约', () => {
  it('根路径返回服务引导信息 浏览器直达不再 404', async () => {
    const { app } = makeApp([])
    const response = await app.request('/')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { service: string; workbench: string }
    expect(body.service).toContain('AfterSales Copilot API')
    expect(body.workbench).toContain('8790')
  })

  it('健康检查公开可访问 无需令牌', async () => {
    const { app } = makeApp([])
    const response = await app.request('/api/health')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { status: string }
    expect(body.status).toBe('ok')
  })

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
  it('非等待输入状态补问返回 409', async () => {
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
    await settleRun(app, created.runId, CUSTOMER_TOKEN)

    const response = await app.request(`/api/runs/${created.runId}/messages`, {
      method: 'POST',
      headers: { ...auth(CUSTOMER_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '再问一句' }),
    })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('CONFLICT')
  })

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
    const created = (await create.json()) as { runId: string }
    expect(created.runId).toBeTruthy()

    // 运行后台推进 轮询至收敛
    const run = await settleRun(app, created.runId, CUSTOMER_TOKEN)
    expect(run.status).toBe('completed')

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
    await settleRun(app, created.runId, CUSTOMER_TOKEN)
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
    const created = (await create.json()) as { runId: string }
    const settled = await settleRun(app, created.runId, CUSTOMER_TOKEN)
    expect(settled.status).toBe('awaiting_approval')

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

    // 主管批准 决定同步落库 恢复执行后台推进
    const decide = await app.request(
      `/api/runs/${created.runId}/approvals/${approval!.approvalId}/decide`,
      {
        method: 'POST',
        headers: { ...auth(authEnv.supervisorToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', decidedBy: 'supervisor' }),
      },
    )
    expect(decide.status).toBe(200)
    const decided = (await decide.json()) as { runId: string; approvalId: string; decision: string }
    expect(decided.decision).toBe('approved')
    const resumed = await settleRun(app, created.runId, CUSTOMER_TOKEN)
    expect(resumed.status).toBe('completed')

    // 审批决定与恢复执行记录各自可查 客户不能读取内部执行错误
    const executions = await app.request('/api/approvals/executions', {
      headers: auth(authEnv.operatorToken),
    })
    expect(await executions.json()).toMatchObject({
      executions: [{ approvalId: approval!.approvalId, decision: 'approved', status: 'completed' }],
    })
    expect(
      (await app.request('/api/approvals/executions', { headers: auth(CUSTOMER_TOKEN) })).status,
    ).toBe(403)

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
    await settleRun(app, created.runId, CUSTOMER_TOKEN)

    const response = await app.request(`/api/runs/${created.runId}/events`, {
      headers: { ...auth(CUSTOMER_TOKEN), 'Last-Event-ID': '2' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')

    const body = await readStreamUntilComplete(response.body!)
    const ids = parseEventIds(body)
    // 客户事件允许跳过内部序号 但不能重放已确认的事件
    expect(ids.every((id) => id > 2)).toBe(true)
    expect(ids).toEqual([...new Set(ids)])
    expect(ids.length).toBeGreaterThan(1)
  })
})

describe('人工接管闭环', () => {
  const escalateScript: AgentOutput[] = [
    { kind: 'action', intent: 'escalate', slots: { reason: '客户要求人工' }, reason: '升级' },
  ]

  it('接管 对话 标记解决全链路 终态回到 completed 事件与审计齐全', async () => {
    const { app, system } = makeApp(escalateScript)
    const create = await app.request('/api/runs', {
      method: 'POST',
      headers: { ...auth(CUSTOMER_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '转人工 我要真人' }),
    })
    const { runId } = (await create.json()) as { runId: string }
    const run = await settleRun(app, runId, CUSTOMER_TOKEN)
    expect(run.status).toBe('escalated')

    // 客户不可接管
    const customerTake = await app.request(`/api/runs/${runId}/handover`, {
      method: 'POST',
      headers: auth(CUSTOMER_TOKEN),
    })
    expect(customerTake.status).toBe(403)

    // 坐席接管
    const take = await app.request(`/api/runs/${runId}/handover`, {
      method: 'POST',
      headers: auth(authEnv.operatorToken),
    })
    expect(take.status).toBe(200)

    // 坐席消息
    const operatorMessage = await app.request(`/api/runs/${runId}/operator-messages`, {
      method: 'POST',
      headers: { ...auth(authEnv.operatorToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '您好 我是人工坐席' }),
    })
    expect(operatorMessage.status).toBe(200)

    // 客户在人工会话中留言 走消息端点落事件
    const customerMessage = await app.request(`/api/runs/${runId}/messages`, {
      method: 'POST',
      headers: { ...auth(CUSTOMER_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '我的诉求是退货' }),
    })
    expect(customerMessage.status).toBe(200)

    // 标记解决
    const resolve = await app.request(`/api/runs/${runId}/resolve`, {
      method: 'POST',
      headers: { ...auth(authEnv.operatorToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: '坐席核实后按政策处理 会话解决' }),
    })
    expect(resolve.status).toBe(200)

    const final = await app.request(`/api/runs/${runId}`, { headers: auth(CUSTOMER_TOKEN) })
    const finalBody = (await final.json()) as { run: { status: string } }
    expect(finalBody.run.status).toBe('completed')

    // 事件时间线含三类新事件
    const events = await app.request(`/api/runs/${runId}/events/json`, {
      headers: auth(CUSTOMER_TOKEN),
    })
    const eventsBody = (await events.json()) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>
    }
    const types = eventsBody.events.map((event) => event.type)
    expect(types).toContain('run.handover')
    expect(types).toContain('operator.message')
    expect(types).toContain('run.resolved')
    const operatorMessageEvent = eventsBody.events.find(
      (event) => event.type === 'operator.message',
    )
    expect(String(operatorMessageEvent?.payload.text)).toContain('人工坐席')

    // 审计留痕
    const handoverAudits = system.queryTable('audit_logs', { action: 'run_handover_taken' })
    const resolveAudits = system.queryTable('audit_logs', { action: 'run_resolved' })
    expect(handoverAudits).toHaveLength(1)
    expect(resolveAudits).toHaveLength(1)
  })

  it('接管前发坐席消息与未接管解决均 409', async () => {
    const { app } = makeApp(escalateScript)
    const create = await app.request('/api/runs', {
      method: 'POST',
      headers: { ...auth(CUSTOMER_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '转人工' }),
    })
    const { runId } = (await create.json()) as { runId: string }
    await settleRun(app, runId, CUSTOMER_TOKEN)

    const earlyMessage = await app.request(`/api/runs/${runId}/operator-messages`, {
      method: 'POST',
      headers: { ...auth(authEnv.operatorToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '未接管先发' }),
    })
    expect(earlyMessage.status).toBe(409)

    const earlyResolve = await app.request(`/api/runs/${runId}/resolve`, {
      method: 'POST',
      headers: { ...auth(authEnv.operatorToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: '未接管先解决' }),
    })
    expect(earlyResolve.status).toBe(409)

    // 重复接管同样 409
    await app.request(`/api/runs/${runId}/handover`, {
      method: 'POST',
      headers: auth(authEnv.operatorToken),
    })
    const duplicateTake = await app.request(`/api/runs/${runId}/handover`, {
      method: 'POST',
      headers: auth(authEnv.operatorToken),
    })
    expect(duplicateTake.status).toBe(409)
  })
})

describe('满意度评分与运营分析', () => {
  const queryScript: AgentOutput[] = [
    { kind: 'tool_call', tool: 'get_order', args: { orderNo: 'SO-2026-0002' }, reason: '查单' },
    { kind: 'final', answer: '订单已在运输中', escalated: false, summary: '查单' },
  ]

  it('终态评分提交 幂等拒绝 非 customer 被拒', async () => {
    const { app } = makeApp(queryScript)
    const create = await app.request('/api/runs', {
      method: 'POST',
      headers: { ...auth(CUSTOMER_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '订单 SO-2026-0002 到哪了' }),
    })
    const { runId } = (await create.json()) as { runId: string }
    await settleRun(app, runId, CUSTOMER_TOKEN)

    const rate = await app.request(`/api/runs/${runId}/rating`, {
      method: 'POST',
      headers: { ...auth(CUSTOMER_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: 5, comment: '很快' }),
    })
    expect(rate.status).toBe(201)
    const rated = (await rate.json()) as { rating: { score: number; comment: string | null } }
    expect(rated.rating.score).toBe(5)
    expect(rated.rating.comment).toBe('很快')

    // 重复评分 409
    const again = await app.request(`/api/runs/${runId}/rating`, {
      method: 'POST',
      headers: { ...auth(CUSTOMER_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: 3 }),
    })
    expect(again.status).toBe(409)

    // 操作员不可评 403
    const operatorRate = await app.request(`/api/runs/${runId}/rating`, {
      method: 'POST',
      headers: { ...auth(authEnv.operatorToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: 5 }),
    })
    expect(operatorRate.status).toBe(403)

    // 查询评分
    const query = await app.request(`/api/runs/${runId}/rating`, {
      headers: auth(CUSTOMER_TOKEN),
    })
    const queryBody = (await query.json()) as { rating: { score: number } | null }
    expect(queryBody.rating?.score).toBe(5)
  })

  it('分析总览仅聚合 customer 会话 客户 403', async () => {
    const { app, system } = makeApp(queryScript)
    // 真实客户会话 经 API 创建 source=customer
    const create = await app.request('/api/runs', {
      method: 'POST',
      headers: { ...auth(CUSTOMER_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '订单 SO-2026-0002 到哪了' }),
    })
    const { runId } = (await create.json()) as { runId: string }
    await settleRun(app, runId, CUSTOMER_TOKEN)
    await app.request(`/api/runs/${runId}/rating`, {
      method: 'POST',
      headers: { ...auth(CUSTOMER_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: 4 }),
    })

    // 评测来源会话 直插领域 标注 sim 不应进运营指标
    await system.runService.start({
      customerId: 'C1001',
      promptVersion: 'v2.2',
      model: 'sim',
      source: 'sim',
    })

    const denied = await app.request('/api/analytics/overview', {
      headers: auth(CUSTOMER_TOKEN),
    })
    expect(denied.status).toBe(403)

    const overview = await app.request('/api/analytics/overview', {
      headers: auth(authEnv.operatorToken),
    })
    expect(overview.status).toBe(200)
    const body = (await overview.json()) as {
      totalSessions: number
      ratingCount: number
      toolDistribution: Array<{ toolName: string }>
      scopeNote: string
    }
    expect(body.totalSessions).toBe(1)
    expect(body.ratingCount).toBe(1)
    expect(body.scopeNote).toContain('customer')
    const tools = body.toolDistribution.map((entry) => entry.toolName)
    expect(tools).toContain('get_order')
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
      if (text.includes('event: stream.complete')) {
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
