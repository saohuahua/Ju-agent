import { afterEach, describe, expect, it } from 'vitest'
import { ScriptedModel } from '@aftersales/agent'
import { FrozenClock } from '@aftersales/domain'
import { composeSystem, type ComposedSystem } from '@aftersales/runtime'
import { clearBusinessData } from '@aftersales/persistence'
import { createApp } from '../src/app.js'

const systems: ComposedSystem[] = []

/** 每个用例使用独立数据库防止备注和审批状态互相污染 */
async function fixture() {
  const system = composeSystem({
    clock: new FrozenClock('2026-09-20T12:00:00Z'),
    model: new ScriptedModel([]),
  })
  systems.push(system)
  const app = createApp({ system, modelAvailable: false })
  const run = await system.runService.start({
    customerId: 'C1001',
    model: 'fixture',
    promptVersion: 'test',
  })
  await system.runService.emit(run.runId, 'message.user', { text: '订单需要售后处理' })
  return { system, app, run }
}

const headers = (token = 'operator-token') => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
})
afterEach(() => {
  for (const system of systems.splice(0)) system.db.close()
})

describe('团队工作台权限与数据边界', () => {
  it('等待审批不能绕过审批入口触发通用恢复', async () => {
    const { app, system, run } = await fixture()
    await system.runService.transition(run.runId, 'running')
    await system.runService.transition(run.runId, 'awaiting_approval')
    const response = await app.request(`/api/runs/${run.runId}/resume`, {
      method: 'POST',
      headers: headers(),
    })
    expect(response.status).toBe(409)
    expect((await system.runService.get(run.runId)).status).toBe('awaiting_approval')
    expect(
      (await system.eventRepo.listByRun(run.runId)).some((event) => event.type === 'run.failed'),
    ).toBe(false)
  })

  it('同一案件中与断点方案不符的审批不能写入决定', async () => {
    const { app, system, run } = await fixture()
    await system.runService.transition(run.runId, 'running')
    await system.runService.transition(run.runId, 'awaiting_approval')
    const approval = await system.approvalService.create({
      runId: run.runId,
      resourceType: 'return_request',
      resourceId: 'RT-fixture',
      reason: '核验资源',
      amountCents: 600000,
      requestedBy: 'workflow',
    })
    system.db
      .prepare(
        'INSERT INTO checkpoints (run_id, step_id, state_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        run.runId,
        'request_approval',
        JSON.stringify({
          approvalId: approval.approvalId,
          approvalResourceType: 'return_request',
          returnNo: 'RT-other',
          refundAmountCents: 600000,
        }),
        system.clock.now().toISOString(),
      )
    const response = await app.request(
      `/api/runs/${run.runId}/approvals/${approval.approvalId}/decide`,
      {
        method: 'POST',
        headers: headers('supervisor-token'),
        body: JSON.stringify({ decision: 'approved', decidedBy: 'supervisor' }),
      },
    )
    expect(response.status).toBe(409)
    expect(
      system.db
        .prepare('SELECT status FROM approval_requests WHERE approval_id = ?')
        .get(approval.approvalId),
    ).toEqual({ status: 'pending' })
    expect(
      system.db.prepare('SELECT COUNT(*) AS count FROM approval_execution_intents').get(),
    ).toEqual({ count: 0 })
  })

  it('相同创建时间的多页案件不重不漏 更新案件不改变游标位置', async () => {
    const { app, system, run } = await fixture()
    const ids = [run.runId]

    for (let index = 0; index < 6; index += 1) {
      const next = await system.runService.start({
        customerId: 'C1001',
        model: 'fixture',
        promptVersion: 'test',
      })
      ids.push(next.runId)
    }

    const seen: string[] = []
    let cursor: string | null = null

    do {
      const response = await app.request(
        `/api/desk/cases?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        { headers: headers() },
      )
      expect(response.status).toBe(200)
      const page = (await response.json()) as {
        cases: Array<{ runId: string }>
        nextCursor: string | null
      }
      seen.push(...page.cases.map((item) => item.runId))
      cursor = page.nextCursor

      // 在翻页之间更新既有案件 验证排序不依赖可变更新时间
      system.db
        .prepare('UPDATE agent_runs SET updated_at = ? WHERE run_id = ?')
        .run('2026-10-01T00:00:00Z', ids[0])
    } while (cursor)

    expect(seen).toEqual([...ids].sort().reverse())
    expect(new Set(seen).size).toBe(ids.length)
  })

  it('关键词搜索覆盖第一页以外的公开消息 但不会检索内部备注', async () => {
    const { app, system, run } = await fixture()
    system.db
      .prepare('UPDATE agent_runs SET created_at = ? WHERE run_id = ?')
      .run('2020-01-01T00:00:00Z', run.runId)
    await system.runService.emit(run.runId, 'message.completed', { text: '旧案件特别关键词' })

    for (let index = 0; index < 101; index += 1) {
      await system.runService.start({
        customerId: 'C1001',
        model: 'fixture',
        promptVersion: 'test',
      })
    }

    const found = await app.request(`/api/desk/cases?q=${encodeURIComponent('旧案件特别关键词')}`, {
      headers: headers(),
    })
    expect(await found.json()).toMatchObject({ cases: [{ runId: run.runId }], nextCursor: null })

    await app.request(`/api/desk/cases/${run.runId}/notes`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ body: '仅备注中出现的词' }),
    })
    const hidden = await app.request(
      `/api/desk/cases?q=${encodeURIComponent('仅备注中出现的词')}`,
      { headers: headers() },
    )
    expect(await hidden.json()).toMatchObject({ cases: [], nextCursor: null })
  })

  it('分页输入严格校验 且游标不能用于不同筛选条件', async () => {
    const { app, system } = await fixture()
    await system.runService.start({ customerId: 'C1001', model: 'fixture', promptVersion: 'test' })
    const response = await app.request('/api/desk/cases?limit=1', { headers: headers() })
    const page = (await response.json()) as { nextCursor: string }

    for (const query of [
      'limit=0',
      'limit=101',
      'limit=1.5',
      'filter=unknown',
      'cursor=broken',
      `cursor=${page.nextCursor}&filter=active`,
      `q=${'x'.repeat(201)}`,
    ]) {
      expect((await app.request(`/api/desk/cases?${query}`, { headers: headers() })).status).toBe(
        400,
      )
    }
  })

  it('不存在的案件与无效检索返回明确错误', async () => {
    const { app } = await fixture()

    expect((await app.request('/api/desk/cases/missing', { headers: headers() })).status).toBe(404)

    for (const query of ['', ' ', '字'.repeat(501)]) {
      const response = await app.request(
        `/api/desk/policies/search?q=${encodeURIComponent(query)}`,
        {
          headers: headers(),
        },
      )
      expect(response.status).toBe(400)
    }
  })

  it('订单证据只关联成功查询且属于当前客户的订单', async () => {
    const { app, system, run } = await fixture()

    // 混入失败查询与跨客户订单验证读模型不会信任请求参数
    const insert = system.db.prepare(`INSERT INTO tool_executions
      (run_id, tool_name, args_json, status, attempt, latency_ms, created_at)
      VALUES (?, 'get_order', ?, ?, 1, 1, ?)`)

    for (const [orderNo, status] of [
      ['SO-2026-0001', 'failed'],
      ['SO-2026-0003', 'succeeded'],
      ['SO-2026-0004', 'succeeded'],
    ]) {
      insert.run(run.runId, JSON.stringify({ orderNo }), status, system.clock.now().toISOString())
    }

    const response = await app.request(`/api/desk/cases/${run.runId}`, { headers: headers() })
    const detail = (await response.json()) as { orders: Array<{ orderNo: string }> }

    expect(detail.orders.map((order) => order.orderNo)).toEqual(['SO-2026-0003'])
  })

  it('案件未等待审批时不能提前写入审批决定', async () => {
    const { app, system, run } = await fixture()
    const approval = await system.approvalService.create({
      runId: run.runId,
      resourceType: 'refund',
      resourceId: 'pending-refund',
      reason: '验证运行状态',
      amountCents: 600000,
      requestedBy: 'operator',
    })
    const response = await app.request(
      `/api/runs/${run.runId}/approvals/${approval.approvalId}/decide`,
      {
        method: 'POST',
        headers: headers('supervisor-token'),
        body: JSON.stringify({ decision: 'approved', decidedBy: 'supervisor' }),
      },
    )

    expect(response.status).toBe(409)
    expect(
      system.db
        .prepare('SELECT status FROM approval_requests WHERE approval_id = ?')
        .get(approval.approvalId),
    ).toEqual({ status: 'pending' })
  })

  it('客户不能读取团队列表文档或内部备注', async () => {
    const { app, run } = await fixture()
    for (const path of [
      '/api/desk/cases',
      `/api/desk/cases/${run.runId}`,
      '/api/desk/policies',
      '/api/desk/policies/search?q=退款',
    ]) {
      expect((await app.request(path, { headers: headers('cust-token-1001') })).status).toBe(403)
    }
    expect(
      (
        await app.request(`/api/desk/cases/${run.runId}/notes`, {
          method: 'POST',
          headers: headers('cust-token-1001'),
          body: JSON.stringify({ body: '不能写入' }),
        })
      ).status,
    ).toBe(403)
  })

  it('内部备注持久保存但不进入客户事件流', async () => {
    const { app, run } = await fixture()
    const response = await app.request(`/api/desk/cases/${run.runId}/notes`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ body: '需要主管核对原支付交易' }),
    })
    expect(response.status).toBe(201)
    const detail = await app.request(`/api/desk/cases/${run.runId}`, { headers: headers() })
    expect(await detail.json()).toMatchObject({
      notes: [{ body: '需要主管核对原支付交易', author: 'operator' }],
    })
    const events = await app.request(`/api/runs/${run.runId}/events/json`, {
      headers: headers('cust-token-1001'),
    })
    expect(await events.text()).not.toContain('需要主管核对原支付交易')
  })

  it('损坏的 JSON 与空白备注返回输入错误且不写数据', async () => {
    const { app, system, run } = await fixture()
    for (const body of [
      '{broken',
      JSON.stringify({ body: '   ' }),
      JSON.stringify({ body: '字'.repeat(2001) }),
    ]) {
      expect(
        (
          await app.request(`/api/desk/cases/${run.runId}/notes`, {
            method: 'POST',
            headers: headers(),
            body,
          })
        ).status,
      ).toBe(400)
    }
    expect(system.db.prepare('SELECT COUNT(*) AS count FROM internal_notes').get()).toEqual({
      count: 0,
    })
  })

  it('清空夹具时先移除内部备注而不触发外键失败', async () => {
    const { app, system, run } = await fixture()
    await app.request(`/api/desk/cases/${run.runId}/notes`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ body: '用于验证重置顺序' }),
    })
    expect(() => clearBusinessData(system.db)).not.toThrow()
    expect(system.db.prepare('SELECT COUNT(*) AS count FROM internal_notes').get()).toEqual({
      count: 0,
    })
  })

  it('无模型密钥也能检索并返回实际政策版本与来源', async () => {
    const { app } = await fixture()
    const response = await app.request('/api/desk/policies/search?q=退款', { headers: headers() })
    expect(response.status).toBe(200)
    const result = (await response.json()) as {
      strategy: string
      articles: Array<Record<string, unknown>>
    }
    expect(result.strategy).toBe('character-keyword-baseline')
    expect(result.articles.length).toBeGreaterThan(0)
    expect(result.articles[0]).toMatchObject({
      policyVersion: expect.any(String),
      source: expect.any(String),
      content: expect.any(String),
    })
  })

  it('跨案件审批请求不能修改审批记录或泄露令牌', async () => {
    const { app, system, run } = await fixture()
    const other = await system.runService.start({
      customerId: 'C1002',
      model: 'fixture',
      promptVersion: 'test',
    })
    await system.runService.transition(other.runId, 'running')
    await system.runService.transition(other.runId, 'awaiting_approval')
    const approval = await system.approvalService.create({
      runId: run.runId,
      resourceType: 'refund',
      resourceId: 'fixture-refund',
      reason: '测试审批归属',
      amountCents: 600000,
      requestedBy: 'operator',
    })
    const listing = await app.request('/api/approvals', { headers: headers() })
    expect(await listing.text()).not.toContain(approval.oneTimeToken)
    const response = await app.request(
      `/api/runs/${other.runId}/approvals/${approval.approvalId}/decide`,
      {
        method: 'POST',
        headers: headers('supervisor-token'),
        body: JSON.stringify({ decision: 'approved', decidedBy: 'supervisor' }),
      },
    )
    expect(response.status).toBe(409)
    expect(
      system.db
        .prepare('SELECT status FROM approval_requests WHERE approval_id = ?')
        .get(approval.approvalId),
    ).toEqual({ status: 'pending' })
  })
})
