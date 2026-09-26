import { afterEach, expect, it } from 'vitest'
import { ApprovalService, FrozenClock } from '@aftersales/domain'
import type { ReturnType } from '@aftersales/contracts'
import { createMemoryDatabase } from '../src/db.js'
import type { SqliteDatabase } from '../src/db.js'
import { SqliteApprovalRepository } from '../src/business-repositories.js'
import { P6TaskRepository } from '../src/p6-task-repository.js'
import { P6AfterSaleRepository } from '../src/p6-after-sale-repository.js'
import type { P6AfterSaleGuard } from '../src/p6-after-sale-repository.js'
import {
  p6ApprovalCommand,
  p6PrepareBusinessPayment,
  p6ApplyBusinessPayment,
  p6ReadyPayment,
} from '../src/p6-business-adapter.js'

const config = {
  snapshotId: 'sale-v1',
  provider: 'scripted',
  model: 'scripted',
  promptVersion: 'v1',
  value: {},
}
const limits = { global: 10, customer: 10, provider: 10, tool: 10 }
const databases: SqliteDatabase[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

/** 独立内存组合根不启动后台或渠道 守卫替身仅断言当前事务供映射测试使用 */
async function fixture(
  type: ReturnType = 'refund_only',
  decision: 'approved' | 'rejected' | 'pending' = 'approved',
) {
  const db = createMemoryDatabase()
  databases.push(db)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO agent_runs(run_id,customer_id,status,prompt_version,model,created_at,updated_at)
    VALUES ('run1','C1','awaiting_approval','v1','scripted',?,?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO return_requests
    (return_no,order_no,customer_id,type,reason,status,item_ids_json,refund_amount_cents,currency,policy_decision_json,policy_version,created_at,updated_at)
    VALUES ('RT1','O1','C1',?,'quality','awaiting_approval','[]',600000,'CNY',?,'v1',?,?)`,
  ).run(type, JSON.stringify({ outcome: 'needs_approval', ruleId: 'R6_large_amount' }), now, now)
  if (type !== 'exchange')
    db.prepare(
      `INSERT INTO refunds
    (refund_no,return_no,order_no,amount_cents,currency,channel,status,idempotency_key,created_at,updated_at)
    VALUES ('RF1','RT1','O1',600000,'CNY','local','created','refund:RT1',?,?)`,
    ).run(now, now)
  const service = new ApprovalService(new SqliteApprovalRepository(db), new FrozenClock(now))
  const approval = await service.create({
    runId: 'run1',
    resourceType: 'return_request',
    resourceId: 'RT1',
    reason: '质量问题',
    amountCents: 600000,
    requestedBy: 'workflow',
  })
  const state = {
    approvalId: approval.approvalId,
    approvalToken: approval.oneTimeToken,
    approvalResourceType: 'return_request',
    returnNo: 'RT1',
    refundNo: type === 'exchange' ? null : 'RF1',
    refundAmountCents: 600000,
    policyOutcome: 'needs_approval',
    requiresApproval: true,
  }
  db.prepare('INSERT INTO checkpoints(run_id,step_id,state_json,created_at) VALUES (?,?,?,?)').run(
    'run1',
    'request_approval',
    JSON.stringify(state),
    now,
  )
  if (decision !== 'pending')
    expect(
      (await service.decide({ role: 'supervisor' }, approval.approvalId, decision, 'run1')).outcome,
    ).toBe('decided')
  const phases: string[] = []
  const guard: P6AfterSaleGuard = (connection, context) => {
    expect(connection).toBe(db)
    expect(connection.inTransaction).toBe(true)
    expect(context.businessKey).toBe(type === 'exchange' ? undefined : 'refund:RT1')
    phases.push(context.phase)
  }
  const tasks = new P6TaskRepository(db)
  const sales = new P6AfterSaleRepository(db, guard)
  const receipt = {
    approvalId: approval.approvalId,
    runId: 'run1',
    customerId: 'C1',
    returnNo: 'RT1',
  }
  return { db, tasks, sales, guard, approval, state, phases, receipt, service }
}

function status(db: SqliteDatabase, table = 'return_requests') {
  return (db.prepare(`SELECT status FROM ${table}`).get() as { status: string } | undefined)?.status
}

/** 模拟可信仓储登记寄回 不调用旧收货入口以免触发其即时付款 */
function shipped(db: SqliteDatabase) {
  db.exec(
    "UPDATE return_requests SET status = 'buyer_shipped', version = version + 1 WHERE status = 'awaiting_buyer_shipment'",
  )
}

it.each(['refund_only', 'return', 'exchange'] as const)(
  '%s 审批通过映射遵循原业务分支且只消费一次',
  async (type) => {
    const f = await fixture(type)
    expect(f.tasks.bridgeApprovals((id) => p6ApprovalCommand(f.db, id, config, f.guard))).toBe(1)
    const task = f.tasks.findRequest('C1', `approval:${f.approval.approvalId}`)!
    expect(f.sales.acceptApproval(f.approval.approvalId, config).taskId).toBe(task.taskId)
    expect(f.tasks.bridgeApprovals((id) => p6ApprovalCommand(f.db, id, config, f.guard))).toBe(0)
    expect(f.phases).toEqual(['approval'])
    expect(f.db.prepare('SELECT one_time_token FROM approval_requests').get()).toEqual({
      one_time_token: '',
    })
    expect(status(f.db)).toBe(type === 'refund_only' ? 'approved' : 'awaiting_buyer_shipment')
    if (type === 'refund_only') {
      expect(task.input.plan.payment).toEqual({
        businessKey: 'refund:RT1',
        resourceId: 'refund:RF1',
        amountCents: 600000,
        currency: 'CNY',
      })
      const claim = f.tasks.claim('worker', 10000, limits)!
      expect(f.tasks.beginPayment(claim, task.input.plan.payment!, p6PrepareBusinessPayment)).toBe(
        true,
      )
    } else {
      expect(task.input.plan.payment).toBeUndefined()
      expect(status(f.db, 'refunds')).toBe(type === 'exchange' ? undefined : 'created')
    }
  },
)

it.each(['refund_only', 'return', 'exchange'] as const)(
  '%s 拒绝终止售后与原退款并清除授权',
  async (type) => {
    const f = await fixture(type, 'rejected')
    const task = f.sales.acceptApproval(f.approval.approvalId, config)
    expect(task.input.plan.payment).toBeUndefined()
    expect(status(f.db)).toBe('rejected')
    expect(status(f.db, 'refunds')).toBe(type === 'exchange' ? undefined : 'cancelled')
    expect(f.db.prepare('SELECT one_time_token FROM approval_requests').get()).toEqual({
      one_time_token: '',
    })
    expect(() => f.sales.receive(f.receipt)).toThrow()
    expect(f.sales.acceptApproval(f.approval.approvalId, config).taskId).toBe(task.taskId)
  },
)

it.each(['refund_only', 'return', 'exchange'] as const)(
  '%s 过期终止包含无意图审批且可重复处理',
  async (type) => {
    const f = await fixture(type, 'pending')
    f.db.exec("UPDATE approval_requests SET expires_at = '2000-01-01T00:00:00.000Z'")
    f.sales.expireApproval(f.approval.approvalId)
    f.sales.expireApproval(f.approval.approvalId)
    expect(status(f.db)).toBe('expired')
    expect(status(f.db, 'approval_requests')).toBe('expired')
    expect(status(f.db, 'refunds')).toBe(type === 'exchange' ? undefined : 'cancelled')
    expect(f.db.prepare('SELECT one_time_token FROM approval_requests').get()).toEqual({
      one_time_token: '',
    })
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM p6_tasks').get()).toEqual({ n: 0 })
  },
)

it('已批准但未受理的过期意图终止且不覆盖批准事实', async () => {
  const f = await fixture()
  f.db.exec("UPDATE approval_requests SET expires_at = '2000-01-01T00:00:00.000Z'")
  expect(() => f.sales.acceptApproval(f.approval.approvalId, config)).toThrow('过期')
  f.sales.expireApproval(f.approval.approvalId)
  expect(status(f.db, 'approval_requests')).toBe('approved')
  expect(status(f.db, 'approval_execution_intents')).toBe('failed')
  expect(status(f.db)).toBe('expired')
  expect(() => p6ReadyPayment(f.db, 'refund', 'RF1', 'C1')).toThrow()
})

it.each([
  ['跨客户', "UPDATE return_requests SET customer_id = 'C2'"],
  ['错误审批金额', 'UPDATE approval_requests SET amount_cents = 1'],
  ['错误退款金额', 'UPDATE refunds SET amount_cents = 1'],
  ['错误退款订单', "UPDATE refunds SET order_no = 'O2'"],
  ['错误币种', "UPDATE refunds SET currency = 'USD'"],
  ['错误业务键', "UPDATE refunds SET idempotency_key = 'refund:RT2'"],
  ['政策不匹配', `UPDATE return_requests SET policy_decision_json = '{"outcome":"deny"}'`],
  ['损坏断点', "UPDATE checkpoints SET state_json = '{'"],
  ['跨案件断点', `UPDATE checkpoints SET state_json = json_set(state_json,'$.approvalId','other')`],
  [
    '错误令牌',
    `UPDATE checkpoints SET state_json = json_set(state_json,'$.approvalToken','other')`,
  ],
  ['错误退款断点', `UPDATE checkpoints SET state_json = json_set(state_json,'$.refundNo','RF2')`],
  [
    '错误断点金额',
    `UPDATE checkpoints SET state_json = json_set(state_json,'$.refundAmountCents',1)`,
  ],
  ['历史运行中意图', "UPDATE approval_execution_intents SET status = 'running'"],
  ['意图决定不一致', "UPDATE approval_execution_intents SET decision = 'rejected'"],
  ['案件状态不一致', "UPDATE agent_runs SET status = 'completed'"],
] as const)('%s 拒绝且没有消费授权或受理任务', async (_name, sql) => {
  const f = await fixture()
  f.db.exec(sql)
  expect(() => f.sales.acceptApproval(f.approval.approvalId, config)).toThrow()
  expect(f.db.prepare('SELECT one_time_token FROM approval_requests').get()).toEqual({
    one_time_token: f.approval.oneTimeToken,
  })
  expect(status(f.db)).toBe('awaiting_approval')
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM p6_tasks').get()).toEqual({ n: 0 })
})

it('只能使用最新断点且不回退到旧有效断点', async () => {
  const f = await fixture()
  f.db
    .prepare('INSERT INTO checkpoints(run_id,step_id,state_json,created_at) VALUES (?,?,?,?)')
    .run('run1', 'other', '{}', new Date().toISOString())
  expect(() => f.sales.acceptApproval(f.approval.approvalId, config)).toThrow('断点')
})

it('退货未收货不创建资金计划且不能通过发送复核', async () => {
  const f = await fixture('return')
  const waiting = f.sales.acceptApproval(f.approval.approvalId, config)
  expect(() => f.sales.receive(f.receipt)).toThrow('寄回')
  const forged = {
    businessKey: 'refund:RT1',
    resourceId: 'refund:RF1',
    amountCents: 600000,
    currency: 'CNY',
  }
  expect(() => p6PrepareBusinessPayment(f.db, forged, waiting)).toThrow('前置条件')
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM p6_effects').get()).toEqual({ n: 0 })
})

it('退货收货沿用原退款与业务键 重复收货和完成后重试只返回原任务', async () => {
  const f = await fixture('return')
  f.sales.acceptApproval(f.approval.approvalId, config)
  shipped(f.db)
  // 审批已受理后使用持久授权 等待寄回不会再次消费已过期令牌
  f.db.exec("UPDATE approval_requests SET expires_at = '2000-01-01T00:00:00.000Z'")
  const task = f.sales.receive(f.receipt)
  expect(f.sales.receive(f.receipt).taskId).toBe(task.taskId)
  expect(task.input.config).toEqual(config)
  expect(status(f.db)).toBe('goods_received')
  expect(task.input.plan.payment).toEqual({
    businessKey: 'refund:RT1',
    resourceId: 'refund:RF1',
    amountCents: 600000,
    currency: 'CNY',
  })
  const claim = f.tasks.claim('worker', 10000, limits, ['return_request'])!
  expect(f.tasks.beginPayment(claim, task.input.plan.payment!, p6PrepareBusinessPayment)).toBe(true)
  f.tasks.settle(
    claim,
    task.input.plan.payment!,
    { status: 'succeeded', transactionId: 'fixture-tx' },
    p6ApplyBusinessPayment,
  )
  expect(status(f.db)).toBe('completed')
  expect(status(f.db, 'refunds')).toBe('succeeded')
  expect(f.sales.receive(f.receipt).taskId).toBe(task.taskId)
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM refunds').get()).toEqual({ n: 1 })
  expect(f.db.prepare('SELECT key FROM idempotency_records').get()).toEqual({ key: 'refund:RT1' })
  expect(f.phases).toEqual(['approval', 'receipt'])
})

it('换货收货按原领域语义完结且永不产生退款或资金计划', async () => {
  const f = await fixture('exchange')
  f.sales.acceptApproval(f.approval.approvalId, config)
  shipped(f.db)
  const task = f.sales.receive(f.receipt)
  expect(f.sales.receive(f.receipt).taskId).toBe(task.taskId)
  expect(status(f.db)).toBe('completed')
  expect(task.input.plan.payment).toBeUndefined()
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM refunds').get()).toEqual({ n: 0 })
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM p6_effects').get()).toEqual({ n: 0 })
})

it.each(['customerId', 'runId', 'returnNo'] as const)('收货拒绝跨案件字段 %s', async (key) => {
  const f = await fixture('return')
  f.sales.acceptApproval(f.approval.approvalId, config)
  shipped(f.db)
  expect(() => f.sales.receive({ ...f.receipt, [key]: 'other' })).toThrow()
  expect(status(f.db)).toBe('buyer_shipped')
})

it('等待期间共同篡改金额不能扩大持久审批授权', async () => {
  const f = await fixture('return')
  f.sales.acceptApproval(f.approval.approvalId, config)
  shipped(f.db)
  f.db.exec(`UPDATE return_requests SET refund_amount_cents = 900000;
    UPDATE refunds SET amount_cents = 900000; UPDATE approval_requests SET amount_cents = 900000;
    UPDATE checkpoints SET state_json = json_set(state_json,'$.refundAmountCents',900000)`)
  expect(() => f.sales.receive(f.receipt)).toThrow('原持久审批')
})

it.each(['approval', 'receipt', 'expiry'] as const)(
  '%s 中途失败回滚所有业务授权意图任务与审计',
  async (phase) => {
    const f = await fixture('return')
    if (phase === 'receipt') {
      f.sales.acceptApproval(f.approval.approvalId, config)
      shipped(f.db)
    }
    if (phase === 'expiry')
      f.db.exec("UPDATE approval_requests SET expires_at = '2000-01-01T00:00:00.000Z'")
    const tables = [
      'return_requests',
      'refunds',
      'approval_requests',
      'approval_execution_intents',
      'p6_commands',
      'p6_tasks',
      'audit_logs',
    ]
    const before = tables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all())
    f.db.exec(
      phase === 'expiry'
        ? `CREATE TRIGGER mapping_fail BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'injected'); END`
        : `CREATE TRIGGER mapping_fail BEFORE INSERT ON p6_tasks BEGIN SELECT RAISE(ABORT,'injected'); END`,
    )
    const act = () =>
      phase === 'approval'
        ? f.sales.acceptApproval(f.approval.approvalId, config)
        : phase === 'receipt'
          ? f.sales.receive(f.receipt)
          : f.sales.expireApproval(f.approval.approvalId)
    expect(act).toThrow('injected')
    expect(tables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before)
    f.db.exec('DROP TRIGGER mapping_fail')
    expect(act).not.toThrow()
  },
)

it('守卫缺失 拒绝和异步返回均不留下授权消费', async () => {
  const f = await fixture()
  expect(() => p6ApprovalCommand(f.db, f.approval.approvalId, config, f.guard)).toThrow('事务')
  expect(() => f.tasks.bridgeApprovals((id) => p6ApprovalCommand(f.db, id, config))).toThrow('守卫')
  const reject = new P6AfterSaleRepository(f.db, () => {
    throw new Error('执行权不匹配')
  })
  expect(() => reject.acceptApproval(f.approval.approvalId, config)).toThrow('执行权')
  const asyncGuard = new P6AfterSaleRepository(f.db, async () => {})
  expect(() => asyncGuard.acceptApproval(f.approval.approvalId, config)).toThrow('同步')
  expect(f.db.prepare('SELECT one_time_token FROM approval_requests').get()).toEqual({
    one_time_token: f.approval.oneTimeToken,
  })
})

it('已持久接管与历史运行中审批均不被过期入口重放', async () => {
  const f = await fixture('return')
  f.sales.acceptApproval(f.approval.approvalId, config)
  f.db.exec("UPDATE approval_requests SET expires_at = '2000-01-01T00:00:00.000Z'")
  expect(() => f.sales.expireApproval(f.approval.approvalId)).toThrow()
  expect(status(f.db)).toBe('awaiting_buyer_shipment')
  const legacy = await fixture()
  legacy.db.exec(
    "UPDATE approval_requests SET expires_at = '2000-01-01T00:00:00.000Z'; UPDATE approval_execution_intents SET status = 'running'",
  )
  expect(() => legacy.sales.expireApproval(legacy.approval.approvalId)).toThrow()
  expect(status(legacy.db)).toBe('awaiting_approval')
})

it('收货拒绝缺失或已取消的持久授权', async () => {
  const f = await fixture('return')
  const approvalTask = f.sales.acceptApproval(f.approval.approvalId, config)
  shipped(f.db)
  f.db
    .prepare("UPDATE p6_tasks SET status = 'cancelled' WHERE task_id = ?")
    .run(approvalTask.taskId)
  expect(() => f.sales.receive(f.receipt)).toThrow('授权')
  const legacy = await fixture('return')
  legacy.db.exec(
    "UPDATE approval_requests SET one_time_token = ''; UPDATE return_requests SET status = 'buyer_shipped'",
  )
  expect(() => legacy.sales.receive(legacy.receipt)).toThrow('授权')
})

it('换货关联异常退款时审批和发送均拒绝', async () => {
  const f = await fixture('return')
  f.db.exec("UPDATE return_requests SET type = 'exchange'")
  expect(() => f.sales.acceptApproval(f.approval.approvalId, config)).toThrow('换货')
  f.db.exec("UPDATE return_requests SET status = 'goods_received'")
  expect(() => p6ReadyPayment(f.db, 'refund', 'RF1', 'C1')).toThrow('绑定')
})

it('执行权守卫的同步写入随受理失败一起回滚', async () => {
  const f = await fixture()
  const sales = new P6AfterSaleRepository(f.db, (db, context) => {
    f.guard(db, context)
    db.prepare(
      `INSERT INTO audit_logs(occurred_at,actor_role,actor_id,action,resource_type,resource_id,detail_json)
      VALUES (?,'system','guard-fixture','guard_claim','return_request','RT1','{}')`,
    ).run(new Date().toISOString())
  })
  f.db.exec(
    `CREATE TRIGGER mapping_fail BEFORE INSERT ON p6_tasks BEGIN SELECT RAISE(ABORT,'injected'); END`,
  )
  expect(() => sales.acceptApproval(f.approval.approvalId, config)).toThrow('injected')
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get()).toEqual({ n: 0 })
})

it('收货发送前不能伪造另一任务来复用原审批授权', async () => {
  const f = await fixture('return')
  f.sales.acceptApproval(f.approval.approvalId, config)
  shipped(f.db)
  const received = f.sales.receive(f.receipt)
  expect(() =>
    p6PrepareBusinessPayment(f.db, received.input.plan.payment!, { ...received, taskId: 'other' }),
  ).toThrow('收货命令')
  expect(status(f.db, 'refunds')).toBe('created')
})
