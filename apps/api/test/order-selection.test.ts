import { afterEach, expect, it } from 'vitest'
import { ScriptedModel } from '@aftersales/agent'
import { FrozenClock } from '@aftersales/domain'
import { composeSystem, conversationDemoOptions, type ComposedSystem } from '@aftersales/runtime'
import { ListMyOrdersInput } from '@aftersales/contracts'
import { SqliteOrderRepository } from '@aftersales/persistence'
import { createApp } from '../src/app.js'
import { customerEvent } from '../src/customer-view.js'
import { DurableConversation } from '../../../packages/runtime/src/durable-conversation.js'
import { createP7Snapshot } from '../../../packages/runtime/src/p7-snapshot.js'

const systems: ComposedSystem[] = []
afterEach(() => systems.splice(0).forEach((system) => system.db.close()))

/** 使用正式演示传输和持久 Worker 验证跨轮选单 不调用资金渠道 */
function setup() {
  const conversation = conversationDemoOptions(true)
  const system = composeSystem({
    clock: new FrozenClock('2026-09-20T12:00:00Z'),
    model: new ScriptedModel([]),
    durableConversation: conversation,
    durableBusiness: { snapshot: conversation.snapshot, paymentUrl: 'http://127.0.0.1:1' },
  })
  systems.push(system)
  const app = createApp({ system, modelAvailable: false })
  let requestId = 0
  const send = async (message: string, runId?: string, key = String(++requestId)) => {
    const response = await app.request(runId ? `/api/runs/${runId}/messages` : '/api/runs', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer cust-token-1001',
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ message }),
    })
    expect(response.status).toBe(202)
    const body = (await response.json()) as { runId: string }
    await system.conversations!.worker.runOnce()
    return body.runId
  }
  const events = (runId: string) => system.conversations!.journal.events(runId)
  return { system, app, send, events, conversation }
}

it('无单号先查本人订单 选择后保留无法开机原因并只创建一次退货', async () => {
  const f = setup()
  const runId = await f.send('商品收到后无法开机 我想退货')
  const publicEvents = await f.app.request(`/api/runs/${runId}/events/json`, {
    headers: { Authorization: 'Bearer cust-token-1001' },
  })
  const published = (
    (await publicEvents.json()) as {
      events: Array<{
        type: string
        payload: Record<string, unknown>
      }>
    }
  ).events
  expect(published.find((event) => event.type === 'message.user')?.payload.requestKey).toBe('1')
  const started = published.filter((event) => event.type === 'tool.requested')
  const finished = published.filter((event) => event.type === 'tool.completed')
  expect(started.length).toBeGreaterThan(0)
  for (const action of started) {
    expect(Object.keys(action.payload).sort()).toEqual(['executionId', 'toolName'])
    expect(finished.some((event) => event.payload.executionId === action.payload.executionId)).toBe(
      true,
    )
  }
  const pages = f.events(runId).filter((event) => event.type === 'order.candidates')
  expect(pages).toHaveLength(1)
  expect(
    f
      .events(runId)
      .filter((event) => event.type === 'run.paused')
      .at(-1)?.payload,
  ).toMatchObject({ missingSlot: 'orderNo' })
  expect(f.system.db.prepare('SELECT COUNT(*) AS n FROM p6_conversation_refunds').get()).toEqual({
    n: 0,
  })
  const selected = '选择订单 SO-2026-0003 商品 item-0003-1'
  await f.send(selected, runId, 'selection')
  await f.send(selected, runId, 'selection')
  const rows = f.system.db
    .prepare(
      "SELECT order_no, reason, item_ids_json FROM return_requests WHERE order_no = 'SO-2026-0003'",
    )
    .all()
  expect(rows).toEqual([
    { order_no: 'SO-2026-0003', reason: 'quality', item_ids_json: '["item-0003-1"]' },
  ])
  expect(f.system.db.prepare('SELECT COUNT(*) AS n FROM p6_conversation_refunds').get()).toEqual({
    n: 1,
  })
})

it('分页按客户隔离且只公开最小字段 不从候选订单自行提交', async () => {
  const f = setup()
  const runId = await f.send('我想退货 无法开机')
  const repo = new SqliteOrderRepository(f.system.db)
  const page = repo.listByCustomer('C1001')
  expect(page.orders).toHaveLength(5)
  expect(page.nextOffset).toBe(5)
  await f.send('查看更多订单', runId)
  const event = f
    .events(runId)
    .filter((item) => item.type === 'order.candidates')
    .at(-1)!
  expect(event.payload).toEqual(repo.listByCustomer('C1001', 5))
  expect(JSON.stringify(event.payload)).not.toMatch(
    /customerId|paymentChannel|phoneMasked|SO-2026-0004/,
  )
  expect(f.system.db.prepare('SELECT COUNT(*) AS n FROM p6_conversation_refunds').get()).toEqual({
    n: 0,
  })
  expect(ListMyOrdersInput.safeParse({ customerId: 'C1002' }).success).toBe(false)
  const denied = await f.app.request(`/api/runs/${runId}`, {
    headers: { Authorization: 'Bearer cust-token-1002' },
  })
  expect(denied.status).toBe(403)
})

it('未知单号和跨客户订单不建单 重新选单后可以继续原诉求', async () => {
  const f = setup()
  const runId = await f.send('无法开机 我想退货 SO-2026-0004')
  expect(
    f
      .events(runId)
      .filter((item) => item.type === 'run.paused')
      .at(-1)?.payload,
  ).toMatchObject({ missingSlot: 'orderNo' })
  expect(f.system.db.prepare('SELECT COUNT(*) AS n FROM p6_conversation_refunds').get()).toEqual({
    n: 0,
  })
  await f.send('重新选择订单', runId)
  await f.send('选择订单 SO-2026-0003 商品 item-0003-1', runId)
  expect(
    f.system.db.prepare("SELECT reason FROM return_requests WHERE order_no = 'SO-2026-0003'").get(),
  ).toEqual({ reason: 'quality' })
})

it('多商品订单明确选一件 不把单商品故障扩大为整单退货', async () => {
  const f = setup()
  f.system.db
    .prepare(
      "UPDATE orders SET status = 'delivered', delivered_at = '2026-09-19T12:00:00Z' WHERE order_no = 'SO-2026-0001'",
    )
    .run()
  const runId = await f.send('SO-2026-0001 不能开机 我要退货')
  expect(
    f
      .events(runId)
      .filter((item) => item.type === 'run.paused')
      .at(-1)?.payload,
  ).toMatchObject({ missingSlot: 'itemIds' })
  await f.send('选择订单 SO-2026-0001 商品 item-0001-1', runId)
  expect(
    f.system.db
      .prepare("SELECT item_ids_json, reason FROM return_requests WHERE order_no = 'SO-2026-0001'")
      .get(),
  ).toEqual({ item_ids_json: '["item-0001-1"]', reason: 'quality' })
})

it('无订单有明确空状态 找不到订单可转人工', async () => {
  const f = setup()
  f.system.db.prepare("DELETE FROM orders WHERE customer_id = 'C1001'").run()
  const runId = await f.send('商品收到后无法开机 我想退货')
  expect(f.events(runId).find((event) => event.type === 'order.candidates')?.payload).toEqual({
    orders: [],
    offset: 0,
    nextOffset: null,
  })
  await f.send('没有我要找的订单 请转人工协助', runId)
  expect(f.events(runId).some((event) => event.type === 'run.escalated')).toBe(true)
})

it('客户候选事件过滤未知字段 非法事件不公开', () => {
  const row = { runId: 'r', sequence: 1, createdAt: '', type: 'order.candidates' as const }
  expect(
    customerEvent({
      ...row,
      payload: { orders: [], offset: 0, nextOffset: null, secret: 'hidden' },
    })?.payload,
  ).toEqual({ orders: [], offset: 0, nextOffset: null })
  expect(customerEvent({ ...row, payload: { orders: 'invalid' } })).toBeNull()
})

it('Worker 重建后恢复候选和补问上下文 原诉求不丢失', async () => {
  const f = setup()
  const runId = await f.send('收到后开不了机 我想退货')
  const before = f.events(runId).filter((event) => event.type === 'order.candidates')
  const restored = new DurableConversation(f.system.db, f.conversation, {
    afterSale: f.system.afterSaleService,
    approvals: f.system.approvalService,
  })
  restored.accept('C1001', 'restored-selection', '选择订单 SO-2026-0003 商品 item-0003-1', runId)
  await restored.worker.runOnce()
  expect(f.events(runId).filter((event) => event.type === 'order.candidates')[0]).toEqual(before[0])
  expect(
    f.system.db.prepare("SELECT reason FROM return_requests WHERE order_no = 'SO-2026-0003'").get(),
  ).toEqual({ reason: 'quality' })
})

it('旧退款快照不自动获得新版查询能力', async () => {
  const f = setup()
  const { version: _version, ...config } = f.conversation.snapshot
  const legacyOptions = {
    ...f.conversation,
    snapshot: createP7Snapshot({ ...config, toolVersion: 'refund-v1' }),
  }
  const legacy = new DurableConversation(f.system.db, legacyOptions, {
    afterSale: f.system.afterSaleService,
    approvals: f.system.approvalService,
  })
  const task = legacy.accept('C1001', 'legacy', '收到后无法开机 我想退货')
  await legacy.worker.runOnce()
  expect(f.events(task.runId).some((event) => event.type === 'order.candidates')).toBe(false)
  expect(
    f
      .events(task.runId)
      .filter((event) => event.type === 'message.completed')
      .at(-1)?.payload,
  ).toMatchObject({ text: '请提供退款订单编号' })
})

it('列表读取失败可重试 且候选列表不能伪装用户选择', async () => {
  const f = setup()
  f.system.db.exec('ALTER TABLE orders RENAME TO temporarily_unavailable_orders')
  const runId = await f.send('收到后无法开机 我想退货')
  expect(
    f
      .events(runId)
      .filter((event) => event.type === 'message.completed')
      .at(-1)?.payload,
  ).toMatchObject({ text: '订单查询暂时失败 可以回复重新查询订单 或转人工协助' })
  f.system.db.exec('ALTER TABLE temporarily_unavailable_orders RENAME TO orders')
  await f.send('重新查询订单', runId)
  expect(f.events(runId).some((event) => event.type === 'order.candidates')).toBe(true)
  expect(f.system.db.prepare('SELECT COUNT(*) AS n FROM p6_conversation_refunds').get()).toEqual({
    n: 0,
  })
})
