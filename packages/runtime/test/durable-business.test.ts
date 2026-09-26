import { afterEach, expect, it } from 'vitest'
import {
  createMemoryDatabase,
  ExecutionOwnershipRepository,
  P6TaskRepository,
  P6OwnedAfterSale,
  startP6PaymentSimulator,
  SqliteApprovalProgressRepository,
} from '@aftersales/persistence'
import { DurableBusiness } from '../src/durable-business.js'
import { conversationDemoOptions } from '../src/conversation-demo.js'
import { seedBusiness } from './fixtures/business-seed.js'
import { p6ConfigFromP7 } from '../src/p6-config-snapshot.js'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const config = p6ConfigFromP7(conversationDemoOptions().snapshot)

async function setup(type = 'return', decision = 'approved') {
  const db = createMemoryDatabase()
  cleanup.push(() => {
    db.close()
  })
  seedBusiness(db, type, decision)
  const channel = createMemoryDatabase()
  cleanup.push(() => {
    channel.close()
  })
  const server = await startP6PaymentSimulator(channel)
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  )
  const address = server.address() as { port: number }
  const runtime = new DurableBusiness(db, {
    snapshot: conversationDemoOptions().snapshot,
    paymentUrl: `http://127.0.0.1:${address.port}`,
  })
  return {
    db,
    channel,
    runtime,
    ownership: new ExecutionOwnershipRepository(db),
    sales: new P6OwnedAfterSale(db),
  }
}

it.each(['refund_only', 'return', 'exchange'])(
  '%s 真实映射与发送许可及结果投影联合闭环',
  async (type) => {
    const f = await setup(type)
    const original = f.runtime.acceptApproval('AP1')
    expect(f.runtime.acceptApproval('AP1').taskId).toBe(original.taskId)
    if (type !== 'exchange') {
      expect(f.ownership.get('refund:RT1')?.holder).toBe(original.commandId)
      expect(() => f.ownership.acquireLegacy('refund:RT1')).toThrow()
    }
    await f.runtime.runOnce()
    if (type !== 'refund_only') {
      expect(new SqliteApprovalProgressRepository(f.db).list()[0]?.outcome).toBe('waiting_return')
      f.db.exec("UPDATE return_requests SET status = 'buyer_shipped' WHERE return_no = 'RT1'")
      const receipt = f.runtime.receive('RT1')
      expect(f.runtime.receive('RT1').taskId).toBe(receipt.taskId)
      if (type === 'return') expect(f.ownership.get('refund:RT1')?.holder).toBe(receipt.commandId)
      expect(f.sales.acceptApproval('AP1', config).taskId).toBe(original.taskId)
      await f.runtime.runOnce()
      expect(new P6TaskRepository(f.db).get(receipt.taskId)?.status).toBe('completed')
    }
    expect(new SqliteApprovalProgressRepository(f.db).list()[0]?.outcome).toBe('succeeded')
    if (type !== 'exchange') expect(f.ownership.get('refund:RT1')?.state).toBe('succeeded')
    expect(
      f.db
        .prepare("SELECT count(*) AS n FROM agent_events WHERE type = 'agent.tool_results'")
        .get(),
    ).toEqual({ n: 1 })
    const before = f.db.prepare('SELECT count(*) AS n FROM agent_events').get()
    await f.runtime.runOnce()
    expect(f.db.prepare('SELECT count(*) AS n FROM agent_events').get()).toEqual(before)
  },
)

it('收货转绑失败回滚收货状态与新命令 保留原授权', async () => {
  const f = await setup()
  f.runtime.acceptApproval('AP1')
  f.db.exec("UPDATE return_requests SET status = 'buyer_shipped'")
  f.db.exec(
    "CREATE TRIGGER fail_rebind BEFORE UPDATE OF holder ON execution_ownership BEGIN SELECT RAISE(ABORT, 'injected'); END",
  )
  expect(() => f.runtime.receive('RT1')).toThrow('injected')
  expect(f.db.prepare('SELECT status FROM return_requests').get()).toEqual({
    status: 'buyer_shipped',
  })
  expect(f.db.prepare('SELECT count(*) AS n FROM p6_tasks').get()).toEqual({ n: 1 })
})

it.each(['sending', 'unknown'])('%s 许可禁止收货新命令重获发送权', async (state) => {
  const f = await setup()
  f.runtime.acceptApproval('AP1')
  f.db.exec("UPDATE return_requests SET status = 'buyer_shipped'")
  f.db.prepare("UPDATE execution_ownership SET state = ?, token = 'held'").run(state)
  expect(() => f.runtime.receive('RT1')).toThrow()
  expect(f.db.prepare('SELECT count(*) AS n FROM p6_tasks').get()).toEqual({ n: 1 })
})

it('受理失败回滚接管与令牌消费', async () => {
  const f = await setup()
  f.db.exec(
    "CREATE TRIGGER fail_accept BEFORE INSERT ON p6_tasks BEGIN SELECT RAISE(ABORT, 'injected'); END",
  )
  expect(() => f.runtime.acceptApproval('AP1')).toThrow('injected')
  expect(f.ownership.get('refund:RT1')).toMatchObject({
    owner: 'legacy',
    state: 'ready',
    holder: '',
  })
  expect(f.db.prepare('SELECT one_time_token AS token FROM approval_requests').get()).toEqual({
    token: 'token',
  })
})

it('拒绝分支没有支付且旧发送入口仍被保护', async () => {
  const f = await setup('return', 'rejected')
  await f.runtime.runOnce()
  expect(new SqliteApprovalProgressRepository(f.db).list()[0]?.outcome).toBe('closed')
  expect(() => f.ownership.acquireLegacy('refund:RT1')).toThrow()
  expect(f.db.prepare('SELECT count(*) AS n FROM p6_effects').get()).toEqual({ n: 0 })
})

it('新扫描器不认领没有接管凭据的历史任务', async () => {
  const f = await setup()
  const tasks = new P6TaskRepository(f.db)
  const historical = tasks.accept({
    customerId: 'C1001',
    requestKey: 'historical',
    kind: 'start',
    config,
    plan: { input: '历史独立任务', tool: 'compensation' },
  })
  await f.runtime.runOnce()
  expect(tasks.get(historical.taskId)).toMatchObject({ status: 'queued', attempt: 0 })
  expect(
    f.db
      .prepare("SELECT 1 FROM p6_events WHERE task_id = ? AND event_key = 'business-projected'")
      .get(historical.taskId),
  ).toBeUndefined()
})

it('未消费售后审批过期后终止原退款 不创建资金任务', async () => {
  const f = await setup('return', 'pending')
  f.db.exec("UPDATE approval_requests SET expires_at = '2000-01-01T00:00:00.000Z'")
  await f.runtime.runOnce()
  expect(f.db.prepare('SELECT status FROM return_requests').get()).toEqual({ status: 'expired' })
  expect(f.db.prepare('SELECT status FROM refunds').get()).toEqual({ status: 'cancelled' })
  expect(f.db.prepare('SELECT count(*) AS n FROM p6_tasks').get()).toEqual({ n: 0 })
  await f.runtime.runOnce()
  expect(
    f.db.prepare("SELECT count(*) AS n FROM agent_events WHERE type = 'run.escalated'").get(),
  ).toEqual({ n: 1 })
})

it('收货渠道未知投影待核验且不能被等待任务完成覆盖', async () => {
  const f = await setup()
  await f.runtime.runOnce()
  f.db.exec("UPDATE return_requests SET status = 'buyer_shipped'")
  f.runtime.receive('RT1')
  f.channel.exec("INSERT INTO p6_channel_faults VALUES ('refund:RT1','unknown')")
  await f.runtime.runOnce()
  expect(new SqliteApprovalProgressRepository(f.db).list()[0]).toMatchObject({
    taskStatus: 'needs_confirmation',
    outcome: 'unknown',
  })
  expect(f.ownership.get('refund:RT1')).toMatchObject({ owner: 'p6', state: 'sending' })
  expect(() => f.ownership.acquireLegacy('refund:RT1')).toThrow()
})
