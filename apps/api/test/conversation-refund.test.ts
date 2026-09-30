import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ScriptedModel, rebuildMessages, buildStepTools } from '@aftersales/agent'
import { SystemClock, KeywordPolicyScorer } from '@aftersales/domain'
import {
  openDatabase,
  startP6PaymentSimulator,
  P6TaskRepository,
  ExecutionOwnershipRepository,
} from '@aftersales/persistence'
import { composeSystem, conversationDemoOptions } from '@aftersales/runtime'
import { createApp } from '../src/app.js'
import { refundConversationOptions } from './fixtures/refund-conversation-options.js'
import type { DurableConversationOptions } from '../../../packages/runtime/src/durable-conversation.js'
import { createP7Snapshot } from '../../../packages/runtime/src/p7-snapshot.js'
import { validateP7Request } from '../../../packages/runtime/src/p7-protocol.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const customer = {
  Authorization: 'Bearer cust-token-1001',
  'Content-Type': 'application/json',
  'Idempotency-Key': 'start',
}
const supervisor = { Authorization: 'Bearer supervisor-token', 'Content-Type': 'application/json' }
const evidence = resolve(
  '..',
  '..',
  'docs/experiments/p6-conversation-refund-evidence',
  new Date().toISOString().replaceAll(':', '-'),
)

async function setup(
  options: {
    action?: string
    reason?: string
    approval?: boolean
    configure?: (options: DurableConversationOptions) => void
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'p6-conversation-refund-'))
  const db = openDatabase(join(directory, 'application.db'))
  const channel = openDatabase(join(directory, 'channel.db'))
  cleanup.push(() => {
    db.close()
    channel.close()
  })
  const server = await startP6PaymentSimulator(channel)
  cleanup.push(() => new Promise<void>((done) => server.close(() => done())))
  const conversation = refundConversationOptions(options.action, options.reason)
  options.configure?.(conversation)
  const system = composeSystem({
    db,
    clock: new SystemClock(),
    model: new ScriptedModel([]),
    policyScorer: new KeywordPolicyScorer(),
    durableConversation: conversation,
    durableBusiness: {
      snapshot: conversation.snapshot,
      paymentUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    },
  })
  // 只播种基础订单事实 不预置售后 审批或资金任务
  db.prepare(
    "UPDATE orders SET total_amount_cents = ?, status = ?, shipped_at = ?, delivered_at = ? WHERE order_no = 'SO-2026-0001'",
  ).run(
    options.approval ? 699900 : 29900,
    options.action === 'submit_return' ? 'delivered' : 'paid',
    options.action === 'submit_return' ? new Date().toISOString() : null,
    options.action === 'submit_return' ? new Date().toISOString() : null,
  )
  const app = createApp({ system, modelAvailable: false })
  const request = (path: string, body: unknown, headers = customer) =>
    app.request(path, { method: 'POST', headers, body: JSON.stringify(body) })
  const start = async (message = '申请退款 SO-2026-0001', key = 'start') => {
    const response = await request(
      '/api/runs',
      { message },
      { ...customer, 'Idempotency-Key': key },
    )
    expect(response.status).toBe(202)
    return (await response.json()) as { runId: string; commandId: string }
  }
  const link = () =>
    db.prepare('SELECT * FROM p6_conversation_refunds ORDER BY rowid LIMIT 1').get() as {
      run_id: string
      return_no: string
      approval_id: string | null
      tool_call_id: string
      authorization_task_id: string | null
      projected: number
    }
  const pump = async () => {
    await system.conversations!.worker.runOnce()
    await system.durableBusiness!.runOnce()
  }
  const channelCounts = () =>
    channel
      .prepare(
        'SELECT COALESCE(SUM(submissions),0) AS submissions, COALESCE(SUM(charges),0) AS charges FROM p6_channel',
      )
      .get()
  const decide = (decision: string) =>
    request(
      `/api/runs/${link().run_id}/approvals/${link().approval_id}/decide`,
      { decision, decidedBy: 'supervisor' },
      supervisor as typeof customer,
    )
  const save = (name: string) => {
    mkdirSync(evidence, { recursive: true })
    writeFileSync(
      join(evidence, `${name}.json`),
      JSON.stringify(
        {
          directory,
          links: db.prepare('SELECT * FROM p6_conversation_refunds').all(),
          tasks: db.prepare('SELECT task_id,command_id,tool,status,attempt FROM p6_tasks').all(),
          refunds: db.prepare('SELECT refund_no,return_no,status,attempts FROM refunds').all(),
          ownership: db
            .prepare('SELECT business_key,owner,holder,state,token FROM execution_ownership')
            .all(),
          channel: channel.prepare('SELECT * FROM p6_channel').all(),
          calls: db
            .prepare('SELECT operation_id,attempt,status,actual,reserved FROM p7_calls')
            .all(),
          events: db.prepare('SELECT run_id,sequence,type,payload_json FROM agent_events').all(),
        },
        null,
        2,
      ),
    )
  }
  return {
    db,
    channel,
    system,
    app,
    request,
    start,
    link,
    pump,
    channelCounts,
    decide,
    save,
    conversation,
  }
}

it('HTTP 客户补问到自动批准仅退款 持久资金执行 原结果和客户事件仅一次', async () => {
  const f = await setup()
  const run = await f.start('我要退款')
  await f.pump()
  expect(
    (
      await f.request(
        `/api/runs/${run.runId}/messages`,
        { message: 'SO-2026-0001' },
        { ...customer, 'Idempotency-Key': 'reply' },
      )
    ).status,
  ).toBe(202)
  await f.pump()
  expect(f.channelCounts()).toEqual({ submissions: 1, charges: 1 })
  expect(
    f.db.prepare('SELECT status FROM refunds WHERE return_no = ?').get(f.link().return_no),
  ).toEqual({ status: 'succeeded' })
  expect(new ExecutionOwnershipRepository(f.db).get(`refund:${f.link().return_no}`)).toMatchObject({
    owner: 'p6',
    state: 'succeeded',
  })
  const events = (await (
    await f.app.request(`/api/runs/${run.runId}/events/json`, { headers: customer })
  ).json()) as { events: Array<{ type: string; payload: unknown }> }
  expect(events.events.filter((event) => event.type === 'run.completed')).toHaveLength(1)
  expect(JSON.stringify(events)).not.toContain('模型声称')
  const results = f.db
    .prepare(
      "SELECT payload_json FROM agent_events WHERE run_id = ? AND type = 'agent.tool_results'",
    )
    .all(run.runId) as { payload_json: string }[]
  expect(
    results
      .flatMap((row) => JSON.parse(row.payload_json).results)
      .filter((result: { toolCallId: string }) => result.toolCallId === f.link().tool_call_id),
  ).toHaveLength(1)
  expect(await f.start('我要退款')).toEqual(run)
  await f.start('再次退款 SO-2026-0001', 'duplicate-action')
  await f.pump()
  await f.pump()
  expect(f.channelCounts()).toEqual({ submissions: 1, charges: 1 })
  expect(f.system.gateway.callLog).toHaveLength(0)
  f.save('automatic-refund')
})

it.each(['approved', 'rejected', 'expired'])(
  '主管审批 %s 前资金零调用 结果来自业务事实',
  async (decision) => {
    const f = await setup({ approval: true })
    await f.start()
    await f.pump()
    expect(f.channelCounts()).toEqual({ submissions: 0, charges: 0 })
    expect(f.link().approval_id).toBeTruthy()
    if (decision === 'expired')
      f.db
        .prepare('UPDATE approval_requests SET expires_at = ? WHERE approval_id = ?')
        .run('2000-01-01T00:00:00.000Z', f.link().approval_id)
    else expect((await f.decide(decision)).status).toBe(202)
    await f.system.durableBusiness!.runOnce()
    expect(f.channelCounts()).toEqual({
      submissions: decision === 'approved' ? 1 : 0,
      charges: decision === 'approved' ? 1 : 0,
    })
    expect(f.link().projected).toBe(1)
    f.save(`approval-${decision}`)
  },
)

it.each([false, true])(
  '退货退款 主管审批 %s 收货前零调用 原授权绑定与重复收货',
  async (approval) => {
    const f = await setup({ action: 'submit_return', reason: 'quality', approval })
    const run = await f.start('质量问题退货退款 SO-2026-0001')
    await f.pump()
    if (approval) {
      expect((await f.decide('approved')).status).toBe(202)
      await f.system.durableBusiness!.runOnce()
    }
    expect(f.channelCounts()).toEqual({ submissions: 0, charges: 0 })
    expect(f.link().projected).toBe(0)
    const original = new ExecutionOwnershipRepository(f.db).get(`refund:${f.link().return_no}`)!
    const reply = {
      message: '已经寄回',
      returnShipment: { returnNo: f.link().return_no, trackingNo: 'LOCAL-RETURN-1' },
    }
    expect(
      (
        await f.request(`/api/runs/${run.runId}/messages`, reply, {
          ...customer,
          'Idempotency-Key': 'shipment',
        })
      ).status,
    ).toBe(202)
    expect(
      (
        await f.request(`/api/runs/${run.runId}/messages`, reply, {
          ...customer,
          'Idempotency-Key': 'shipment',
        })
      ).status,
    ).toBe(202)
    expect(f.channelCounts()).toEqual({ submissions: 0, charges: 0 })
    const receive = () =>
      f.request(
        '/api/operations/receive-goods',
        { returnNo: f.link().return_no },
        supervisor as typeof customer,
      )
    expect((await receive()).status).toBe(202)
    expect((await receive()).status).toBe(202)
    const holder = new ExecutionOwnershipRepository(f.db).get(`refund:${f.link().return_no}`)!
    expect(holder.holder).not.toBe(original.holder)
    await f.system.durableBusiness!.runOnce()
    expect(f.channelCounts()).toEqual({ submissions: 1, charges: 1 })
    expect((await receive()).status).toBe(202)
    await f.system.durableBusiness!.runOnce()
    expect(f.channelCounts()).toEqual({ submissions: 1, charges: 1 })
    expect(f.link().projected).toBe(1)
    expect(() =>
      validateP7Request(
        {
          system: 'offline',
          tools: buildStepTools({ actions: ['escalate', 'submit_return', 'submit_refund_only'] }),
          messages: rebuildMessages(f.system.conversations!.journal.events(run.runId)),
        },
        f.conversation.snapshot,
      ),
    ).not.toThrow()
    f.save(`return-${approval}`)
  },
)

it('客户越权 原流程篡改均拒绝且不能通过旧同步路径付款', async () => {
  const f = await setup({ action: 'submit_return', reason: 'quality' })
  const run = await f.start()
  await f.pump()
  expect(
    (
      await f.request(
        `/api/runs/${run.runId}/messages`,
        { message: '寄回' },
        { ...customer, Authorization: 'Bearer cust-token-1002' },
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await f.request(
        `/api/runs/${run.runId}/messages`,
        { message: '寄回', returnShipment: { returnNo: 'OTHER', trackingNo: 'LOCAL' } },
        { ...customer, 'Idempotency-Key': 'tamper' },
      )
    ).status,
  ).toBe(409)
  f.db
    .prepare('UPDATE refunds SET amount_cents = amount_cents + 1 WHERE return_no = ?')
    .run(f.link().return_no)
  expect(
    (
      await f.request(
        `/api/runs/${run.runId}/messages`,
        { message: '寄回', returnShipment: { returnNo: f.link().return_no, trackingNo: 'LOCAL' } },
        { ...customer, 'Idempotency-Key': 'tamper-amount' },
      )
    ).status,
  ).toBe(409)
  expect(f.channelCounts()).toEqual({ submissions: 0, charges: 0 })
  f.save('authorization-conflicts')
})

it('未知资金不释放发送许可 人工接管不能抹去未知状态', async () => {
  const f = await setup()
  const run = await f.start()
  await f.system.conversations!.worker.runOnce()
  const key = `refund:${f.link().return_no}`
  f.channel.prepare("INSERT INTO p6_channel_faults VALUES (?,'unknown')").run(key)
  await f.system.durableBusiness!.runOnce()
  expect(f.channelCounts()).toEqual({ submissions: 1, charges: 0 })
  expect(f.db.prepare("SELECT status FROM p6_tasks WHERE tool = 'return_request'").get()).toEqual({
    status: 'needs_confirmation',
  })
  const ownership = new ExecutionOwnershipRepository(f.db)
  expect(ownership.get(key)).toMatchObject({ state: 'sending', owner: 'p6' })
  expect(() => ownership.takeoverWithCommand(key, () => ({ commandId: 'bad' }))).toThrow()
  expect(
    (await f.request(`/api/runs/${run.runId}/handover`, {}, supervisor as typeof customer)).status,
  ).toBe(200)
  const task = f.db
    .prepare("SELECT task_id AS id FROM p6_tasks WHERE tool = 'return_request'")
    .get() as { id: string }
  new P6TaskRepository(f.db).reconcile(task.id)
  await f.system.durableBusiness!.runOnce()
  expect(f.channelCounts()).toEqual({ submissions: 1, charges: 0 })
  expect(f.link().projected).toBe(0)
  f.save('unknown-funds')
})

it.each(['compensation', 'price_protection', 'submit_exchange'])(
  '未迁移动作 %s 明确阻断 不回退旧资金服务',
  async (action) => {
    const f = await setup({ action })
    await f.start()
    await f.pump()
    await f.pump()
    expect(f.channelCounts()).toEqual({ submissions: 0, charges: 0 })
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM p6_conversation_refunds').get()).toEqual({
      n: 0,
    })
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM p7_calls').get()).toEqual({ n: 3 })
    f.save(`unsupported-${action}`)
  },
)

it('自动批准受理失败完整回滚售后 退款 执行权与动作关联', async () => {
  const f = await setup()
  f.db.exec(
    "CREATE TRIGGER reject_business BEFORE INSERT ON p6_tasks WHEN NEW.tool = 'return_request' BEGIN SELECT RAISE(ABORT,'injected acceptance failure'); END",
  )
  await f.start()
  await f.pump()
  expect(
    f.db.prepare("SELECT COUNT(*) AS n FROM return_requests WHERE order_no = 'SO-2026-0001'").get(),
  ).toEqual({ n: 0 })
  expect(
    f.db.prepare("SELECT COUNT(*) AS n FROM refunds WHERE order_no = 'SO-2026-0001'").get(),
  ).toEqual({ n: 0 })
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM p6_conversation_refunds').get()).toEqual({ n: 0 })
  expect(
    f.db.prepare("SELECT COUNT(*) AS n FROM execution_ownership WHERE owner = 'p6'").get(),
  ).toEqual({ n: 0 })
  expect(f.channelCounts()).toEqual({ submissions: 0, charges: 0 })
  f.save('atomic-acceptance-rollback')
})

it('旧会话 Worker 失去租约不能创建业务 新代次从原动作恢复', async () => {
  const f = await setup()
  let lost = false
  f.conversation.boundary = async (name, task) => {
    if (name === 'before-business-accept' && !lost) {
      lost = true
      f.db.prepare('UPDATE p6_tasks SET lease_until = 0 WHERE task_id = ?').run(task.taskId)
    }
  }
  await f.start()
  await f.pump()
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM p6_conversation_refunds').get()).toEqual({ n: 0 })
  expect(f.channelCounts()).toEqual({ submissions: 0, charges: 0 })
  await f.pump()
  expect(f.channelCounts()).toEqual({ submissions: 1, charges: 1 })
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM p7_calls').get()).toEqual({ n: 3 })
  f.save('stale-conversation-fence')
})

it('网关三次尝试耗尽不会叠加 Worker 模型重试 未知费用保留', async () => {
  const f = await setup({
    configure: (options) => {
      const { version: _version, ...config } = options.snapshot
      options.snapshot = createP7Snapshot({ ...config, maxAttempts: 3 })
      options.transport = () => ({
        mode: 'simulation',
        async *stream() {
          yield* []
          throw Object.assign(new Error('offline transient'), { status: 503 })
        },
      })
    },
  })
  await f.start()
  await f.pump()
  await f.pump()
  await f.pump()
  expect(
    f.db.prepare('SELECT attempt,status,actual,reserved FROM p7_calls ORDER BY attempt').all(),
  ).toEqual([
    { attempt: 1, status: 'unknown', actual: null, reserved: 10 },
    { attempt: 2, status: 'unknown', actual: null, reserved: 10 },
    { attempt: 3, status: 'unknown', actual: null, reserved: 10 },
  ])
  expect(
    f.db.prepare("SELECT attempt,status FROM p6_tasks WHERE tool = 'conversation'").get(),
  ).toEqual({ attempt: 1, status: 'call_failed' })
  expect(f.channelCounts()).toEqual({ submissions: 0, charges: 0 })
  f.save('model-retry-budget')
})

it('越权订单即使模型仍提出退款也无法建单', async () => {
  const f = await setup()
  await f.start('退款 SO-2026-0004')
  await f.pump()
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM p6_conversation_refunds').get()).toEqual({ n: 0 })
  expect(f.channelCounts()).toEqual({ submissions: 0, charges: 0 })
  f.save('cross-customer-order')
})

it.each(['sending', 'unknown', 'unassigned'])(
  '自动批准退货的 %s 执行权不能在收货时重获',
  async (state) => {
    const f = await setup({ action: 'submit_return', reason: 'quality' })
    const run = await f.start()
    await f.pump()
    await f.request(
      `/api/runs/${run.runId}/messages`,
      { message: '寄回', returnShipment: { returnNo: f.link().return_no, trackingNo: 'LOCAL' } },
      { ...customer, 'Idempotency-Key': 'shipped' },
    )
    f.db
      .prepare(
        'UPDATE execution_ownership SET owner = ?, state = ?, token = ? WHERE business_key = ?',
      )
      .run(
        state === 'unassigned' ? 'unassigned' : 'p6',
        state === 'unassigned' ? 'unknown' : state,
        'original-permit',
        `refund:${f.link().return_no}`,
      )
    expect(() => f.system.durableBusiness!.receive(f.link().return_no)).toThrow()
    expect(
      f.db
        .prepare('SELECT status FROM return_requests WHERE return_no = ?')
        .get(f.link().return_no),
    ).toEqual({ status: 'buyer_shipped' })
    expect(f.channelCounts()).toEqual({ submissions: 0, charges: 0 })
    f.save(`receipt-${state}`)
  },
)

it('发送后取消仍保留已确认退款和原调用结果', async () => {
  const f = await setup()
  await f.start()
  await f.system.conversations!.worker.runOnce()
  const task = new P6TaskRepository(f.db).get(f.link().authorization_task_id!)!
  // 模拟渠道成功后请求取消 不改写已发生的资金事实
  f.channel
    .prepare("INSERT INTO p6_channel_faults VALUES (?,'delayed')")
    .run(`refund:${f.link().return_no}`)
  const work = f.system.durableBusiness!.runOnce()
  for (let i = 0; i < 100 && (f.channelCounts() as { charges: number }).charges === 0; i++)
    await new Promise((done) => setTimeout(done, 10))
  expect(new P6TaskRepository(f.db).cancel(task.taskId, task.customerId)).toBe(true)
  await work
  expect(f.channelCounts()).toEqual({ submissions: 1, charges: 1 })
  expect(
    f.db.prepare('SELECT status FROM refunds WHERE return_no = ?').get(f.link().return_no),
  ).toEqual({ status: 'succeeded' })
  expect(f.link().projected).toBe(1)
  f.save('cancel-after-send')
})

it('旧只读快照不会因装配业务 Worker 获得退款工具', async () => {
  const f = await setup({
    configure: (options) => {
      options.snapshot = conversationDemoOptions().snapshot
    },
  })
  await f.start()
  await f.pump()
  expect(f.channelCounts()).toEqual({ submissions: 0, charges: 0 })
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM p6_conversation_refunds').get()).toEqual({ n: 0 })
  f.save('readonly-snapshot')
})

it('模型跨轮复用工具调用标识在业务受理前拒绝', async () => {
  const f = await setup({
    configure: (options) => {
      const transport = options.transport
      options.transport = (snapshot) => ({
        mode: 'simulation',
        async *stream(body, signal) {
          for await (const raw of transport(snapshot).stream(body, signal)) {
            const frame = raw as { type: string; content_block?: { type: string; id: string } }
            if (frame.type === 'content_block_start' && frame.content_block?.type === 'tool_use')
              frame.content_block.id = 'reused-id'
            yield frame
          }
        },
      })
    },
  })
  await f.start()
  await f.pump()
  expect(f.channelCounts()).toEqual({ submissions: 0, charges: 0 })
  expect(
    f.db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE type = 'agent.turn'").get(),
  ).toEqual({ n: 1 })
  f.save('duplicate-tool-identity')
})

it('正式模拟装配的退款演示协议通过客户入口完成自动批准退款', async () => {
  const f = await setup({
    configure: (options) => Object.assign(options, conversationDemoOptions(true)),
  })
  await f.start('未发货申请退款 SO-2026-0001')
  await f.pump()
  expect(f.channelCounts()).toEqual({ submissions: 1, charges: 1 })
  expect(f.link().projected).toBe(1)
  f.save('formal-demo-refund')
})
