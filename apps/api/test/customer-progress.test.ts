import { afterEach, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedModel } from '@aftersales/agent'
import { CustomerRefundProgress } from '@aftersales/contracts'
import { SystemClock } from '@aftersales/domain'
import { openDatabase, startP6PaymentSimulator } from '@aftersales/persistence'
import { composeSystem } from '@aftersales/runtime'
import { createApp } from '../src/app.js'
import { refundConversationOptions } from './fixtures/refund-conversation-options.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

/** 从客户消息创建业务 只播种独立订单夹具 */
async function setup(returning = true, approval = true) {
  const directory = mkdtempSync(join(tmpdir(), 'customer-progress-'))
  const db = openDatabase(join(directory, 'application.db'))
  const channel = openDatabase(join(directory, 'channel.db'))
  cleanup.push(() => {
    db.close()
    channel.close()
  })
  const server = await startP6PaymentSimulator(channel)
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const options = refundConversationOptions(
    returning ? 'submit_return' : 'submit_refund_only',
    returning ? 'quality' : 'unshipped_cancel',
  )
  const system = composeSystem({
    db,
    clock: new SystemClock(),
    model: new ScriptedModel([]),
    durableConversation: options,
    durableBusiness: {
      snapshot: options.snapshot,
      paymentUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    },
  })
  db.prepare(
    "UPDATE orders SET total_amount_cents = ?, status = ?, shipped_at = ?, delivered_at = ? WHERE order_no = 'SO-2026-0001'",
  ).run(
    approval ? 699900 : 29900,
    returning ? 'delivered' : 'paid',
    returning ? new Date().toISOString() : null,
    returning ? new Date().toISOString() : null,
  )
  const app = createApp({ system, modelAvailable: false })
  const post = (path: string, body: unknown, key = 'start', token = 'cust-token-1001') =>
    app.request(path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    })
  const response = await post('/api/runs', { message: '申请退款 SO-2026-0001' })
  const { runId } = (await response.json()) as { runId: string }
  const get = (token = 'cust-token-1001') =>
    app.request(`/api/runs/${runId}/customer-progress`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  const progress = async () => {
    const response = await get()
    expect(response.status).toBe(200)
    return ((await response.json()) as { progress: CustomerRefundProgress | null }).progress
  }
  const link = () =>
    db
      .prepare('SELECT return_no, approval_id FROM p6_conversation_refunds WHERE run_id = ?')
      .get(runId) as { return_no: string; approval_id: string | null }
  const pump = async () => {
    await system.conversations!.worker.runOnce()
    await system.durableBusiness!.runOnce()
  }
  const decide = async (decision = 'approved') => {
    const response = await post(
      `/api/runs/${runId}/approvals/${link().approval_id}/decide`,
      { decision, decidedBy: 'supervisor' },
      'decide',
      'supervisor-token',
    )
    await system.durableBusiness!.runOnce()
    return response
  }
  const shipment = (returnNo = link().return_no, trackingNo = '邮政 / LOCAL 123') => ({
    message: '已寄回商品 请核对寄回信息',
    returnShipment: { returnNo, trackingNo },
  })
  const counts = () =>
    channel
      .prepare(
        'SELECT COALESCE(SUM(submissions),0) submissions, COALESCE(SUM(charges),0) charges FROM p6_channel',
      )
      .get()
  return {
    app,
    db,
    channel,
    system,
    post,
    get,
    progress,
    runId,
    pump,
    decide,
    link,
    shipment,
    counts,
  }
}

it('空进度和本人权限 客户 DTO 严格白名单且只读', async () => {
  const f = await setup()
  expect(await f.progress()).toBeNull()
  expect((await f.get('cust-token-1002')).status).toBe(403)
  expect((await f.get('operator-token')).status).toBe(403)
  await f.pump()
  const before = f.db.prepare('SELECT total_changes() n').get()
  const dto = await f.progress()
  expect(CustomerRefundProgress.strict().parse(dto)).toEqual(dto)
  expect(dto).toMatchObject({
    returnNo: f.link().return_no,
    type: 'return',
    progress: 'awaiting_approval',
    canRegisterShipment: false,
  })
  expect(f.db.prepare('SELECT total_changes() n').get()).toEqual(before)
  for (const field of [
    'token',
    'input_json',
    'binding_json',
    'taskId',
    'approvalId',
    'business_key',
    'ledger',
  ])
    expect(JSON.stringify(dto)).not.toContain(field)
})

it('主管审批到寄回收货退款 对照公开事实及幂等和渠道计数', async () => {
  const f = await setup()
  await f.pump()
  expect((await f.post(`/api/runs/${f.runId}/messages`, f.shipment(), 'too-early')).status).toBe(
    409,
  )
  expect((await f.decide()).status).toBe(202)
  expect(await f.progress()).toMatchObject({
    progress: 'awaiting_shipment',
    canRegisterShipment: true,
    shipmentRegistered: false,
  })
  expect(
    (await f.post(`/api/runs/${f.runId}/messages`, f.shipment('RETURN-OTHER'), 'tampered')).status,
  ).toBe(409)
  expect(
    (await f.post(`/api/runs/${f.runId}/messages`, f.shipment(), 'other', 'cust-token-1002'))
      .status,
  ).toBe(403)
  expect(
    (await f.post('/api/operations/receive-goods', { returnNo: f.link().return_no })).status,
  ).toBe(403)
  expect(f.counts()).toEqual({ submissions: 0, charges: 0 })
  for (let i = 0; i < 3; i++)
    expect((await f.post(`/api/runs/${f.runId}/messages`, f.shipment(), 'shipment')).status).toBe(
      202,
    )
  expect(await f.progress()).toMatchObject({
    progress: 'awaiting_receipt',
    canRegisterShipment: false,
    shipmentRegistered: true,
    trackingNo: '邮政 / LOCAL 123',
  })
  expect(
    f.db.prepare("SELECT COUNT(*) n FROM p6_commands WHERE request_key = 'shipment'").get(),
  ).toEqual({ n: 1 })
  expect(
    f.db
      .prepare("SELECT COUNT(*) n FROM audit_logs WHERE action = 'return_shipment_recorded'")
      .get(),
  ).toEqual({ n: 1 })
  expect(f.counts()).toEqual({ submissions: 0, charges: 0 })
  expect(
    (
      await f.post(
        '/api/operations/receive-goods',
        { returnNo: f.link().return_no },
        'receive',
        'operator-token',
      )
    ).status,
  ).toBe(202)
  await f.pump()
  expect(await f.progress()).toMatchObject({ progress: 'succeeded', canRegisterShipment: false })
  expect(f.counts()).toEqual({ submissions: 1, charges: 1 })
  expect(
    f.db
      .prepare("SELECT COUNT(*) n FROM agent_events WHERE run_id = ? AND type = 'run.completed'")
      .get(f.runId),
  ).toEqual({ n: 1 })
  const replayApp = createApp({ system: f.system, modelAvailable: false })
  const restored = await replayApp.request(`/api/runs/${f.runId}/customer-progress`, {
    headers: { Authorization: 'Bearer cust-token-1001' },
  })
  expect(await restored.json()).toEqual({ progress: await f.progress() })
})

it('仅退款没有寄回权限 已确认成功才显示成功', async () => {
  const f = await setup(false, false)
  await f.system.conversations!.worker.runOnce()
  expect(await f.progress()).toMatchObject({
    type: 'refund_only',
    canRegisterShipment: false,
    progress: 'processing',
  })
  await f.system.durableBusiness!.runOnce()
  expect(await f.progress()).toMatchObject({ progress: 'succeeded', canRegisterShipment: false })
  f.db.prepare("UPDATE execution_ownership SET token = ''").run()
  expect(await f.progress()).toMatchObject({ progress: 'unknown', canRegisterShipment: false })
  f.db.prepare("UPDATE p6_effects SET status = 'unknown'").run()
  expect(await f.progress()).toMatchObject({ progress: 'unknown', canRegisterShipment: false })
})

it.each(['rejected', 'expired'])('审批 %s 时不能寄回', async (state) => {
  const f = await setup()
  await f.pump()
  if (state === 'rejected') await f.decide('rejected')
  else
    f.db
      .prepare(
        "UPDATE approval_requests SET expires_at = '2020-01-01T00:00:00Z' WHERE approval_id = ?",
      )
      .run(f.link().approval_id)
  expect(await f.progress()).toMatchObject({ progress: state, canRegisterShipment: false })
  expect((await f.post(`/api/runs/${f.runId}/messages`, f.shipment(), 'blocked')).status).toBe(409)
  expect(f.counts()).toEqual({ submissions: 0, charges: 0 })
})

it('资金未知优先于人工状态 不把接管或模型文字当成功', async () => {
  const f = await setup(false, false)
  await f.system.conversations!.worker.runOnce()
  f.channel
    .prepare("INSERT INTO p6_channel_faults VALUES (?,'unknown')")
    .run(`refund:${f.link().return_no}`)
  await f.system.durableBusiness!.runOnce()
  await f.post(`/api/runs/${f.runId}/handover`, {}, 'handover', 'operator-token')
  await f.system.runService.emit(f.runId, 'message.completed', { text: '模型声称退款成功' })
  expect(await f.progress()).toMatchObject({ progress: 'unknown', canRegisterShipment: false })
  expect(f.counts()).toEqual({ submissions: 1, charges: 0 })
})

it('人工接管后拒绝结构化寄回且不写入 普通客户留言仍可发送', async () => {
  const f = await setup(true, false)
  await f.pump()
  expect(await f.progress()).toMatchObject({ canRegisterShipment: true })
  await f.system.runService.transition(f.runId, 'running')
  await f.system.runService.transition(f.runId, 'escalated')
  expect(
    (await f.post(`/api/runs/${f.runId}/handover`, {}, 'handover', 'operator-token')).status,
  ).toBe(200)
  expect(await f.progress()).toMatchObject({ progress: 'human', canRegisterShipment: false })
  const before = f.db.prepare('SELECT total_changes() n').get()
  expect(
    (await f.post(`/api/runs/${f.runId}/messages`, f.shipment(), 'foreign', 'cust-token-1002'))
      .status,
  ).toBe(403)
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await f.post(`/api/runs/${f.runId}/messages`, f.shipment(), 'after-handover')
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'CONFLICT',
      message: '会话已由人工接管 无法在此登记寄回 请联系坐席核验',
    })
  }
  expect(f.db.prepare('SELECT total_changes() n').get()).toEqual(before)
  const messages = () =>
    f.db
      .prepare("SELECT COUNT(*) n FROM agent_events WHERE run_id = ? AND type = 'message.user'")
      .get(f.runId) as { n: number }
  const count = messages().n
  expect(
    (
      await f.post(
        `/api/runs/${f.runId}/messages`,
        { message: '请坐席帮我核验寄回方式' },
        'human-message',
      )
    ).status,
  ).toBe(200)
  expect(messages().n).toBe(count + 1)
  expect(await f.progress()).toMatchObject({ progress: 'human', shipmentRegistered: false })
  expect(f.counts()).toEqual({ submissions: 0, charges: 0 })
})

it('售后关联篡改返回可恢复错误 不泄漏诊断', async () => {
  const f = await setup()
  await f.pump()
  f.db
    .prepare("UPDATE return_requests SET customer_id = 'C1002' WHERE return_no = ?")
    .run(f.link().return_no)
  const response = await f.get()
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    error: 'PROGRESS_UNAVAILABLE',
    message: '进度暂时无法核验 请稍后重试',
  })
})
