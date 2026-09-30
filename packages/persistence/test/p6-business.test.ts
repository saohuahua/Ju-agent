import { expect, it } from 'vitest'
import { ApprovalService, FrozenClock } from '@aftersales/domain'
import { createMemoryDatabase } from '../src/db.js'
import type { SqliteDatabase } from '../src/db.js'
import { SqliteApprovalRepository } from '../src/business-repositories.js'
import { migrateP6 } from '../src/p6-migration.js'
import { P6TaskRepository } from '../src/p6-task-repository.js'
import {
  p6ApprovalCommand,
  p6ApplyBusinessPayment,
  p6PrepareBusinessPayment,
  p6ReadyPayment,
} from '../src/p6-business-adapter.js'

const config = {
  snapshotId: 'fixture-v1',
  provider: 'scripted',
  model: 'scripted',
  promptVersion: 'v1',
  value: {},
}
const limits = { global: 2, customer: 2, provider: 2, tool: 2 }
const now = new Date().toISOString()

/** 最小真实表夹具只建立领域已准备的单据 不模拟付款结果 */
function seed(
  db: SqliteDatabase,
  kind: 'compensation' | 'price_protection' | 'refund',
  approval = false,
) {
  if (kind === 'compensation')
    db.prepare(
      `INSERT INTO compensations
    (compensation_no,order_no,customer_id,reason,status,amount_cents,currency,requires_approval,policy_version,created_at,updated_at)
    VALUES ('CP1','O1','C1','logistics_delay',?,100,'CNY',?,'v1',?,?)`,
    ).run(approval ? 'awaiting_approval' : 'auto_approved', Number(approval), now, now)
  else if (kind === 'price_protection')
    db.prepare(
      `INSERT INTO price_protections
    (protection_no,order_no,customer_id,status,amount_cents,currency,items_json,requires_approval,policy_rule_id,policy_version,created_at,updated_at)
    VALUES ('PP1','O1','C1',?,100,'CNY','[]',?,'test','v1',?,?)`,
    ).run(approval ? 'awaiting_approval' : 'auto_approved', Number(approval), now, now)
  else {
    db.prepare(
      `INSERT INTO return_requests
      (return_no,order_no,customer_id,type,reason,status,item_ids_json,refund_amount_cents,currency,policy_decision_json,policy_version,created_at,updated_at)
      VALUES ('RT1','O1','C1','refund_only','test','auto_approved','[]',100,'CNY',?,'v1',?,?)`,
    ).run(JSON.stringify({ outcome: approval ? 'needs_approval' : 'allow' }), now, now)
    db.prepare(
      `INSERT INTO refunds
      (refund_no,return_no,order_no,amount_cents,currency,channel,status,idempotency_key,created_at,updated_at)
      VALUES ('RF1','RT1','O1',100,'CNY','local','created','refund:RT1',?,?)`,
    ).run(now, now)
  }
  return kind === 'compensation' ? 'CP1' : kind === 'price_protection' ? 'PP1' : 'RF1'
}

it.each(['compensation', 'price_protection', 'refund'] as const)(
  'P6 %s 发送状态与终态同事务回写既有业务表',
  (kind) => {
    const db = createMemoryDatabase()
    migrateP6(db)
    try {
      const id = seed(db, kind)
      const repo = new P6TaskRepository(db)
      const payment = p6ReadyPayment(db, kind, id, 'C1')
      repo.accept({
        customerId: 'C1',
        requestKey: 'key',
        kind: 'start',
        config,
        plan: { input: '', tool: kind, payment },
      })
      const claim = repo.claim('worker', 1000, limits)!
      expect(repo.beginPayment(claim, payment, p6PrepareBusinessPayment)).toBe(true)
      repo.settle(
        claim,
        payment,
        { status: 'succeeded', transactionId: 'tx1' },
        p6ApplyBusinessPayment,
      )
      const table =
        kind === 'compensation'
          ? 'compensations'
          : kind === 'price_protection'
            ? 'price_protections'
            : 'refunds'
      expect(db.prepare(`SELECT status FROM ${table}`).get()).toEqual({ status: 'succeeded' })
      expect(db.prepare('SELECT key FROM idempotency_records').get()).toEqual({
        key: payment.businessKey,
      })
      if (kind === 'refund')
        expect(db.prepare('SELECT status FROM return_requests').get()).toEqual({
          status: 'completed',
        })
    } finally {
      db.close()
    }
  },
)

it.each(['compensation', 'price_protection', 'refund'] as const)(
  'P6 %s 不绕过原业务审批与归属',
  (kind) => {
    const db = createMemoryDatabase()
    try {
      const id = seed(db, kind, true)
      expect(() => p6ReadyPayment(db, kind, id, 'C2')).toThrow('归属')
      expect(() => p6ReadyPayment(db, kind, id, 'C1')).toThrow()
    } finally {
      db.close()
    }
  },
)

it.each(['compensation', 'price_protection'] as const)(
  'P6 %s 桥接失败回滚令牌与业务状态 成功只受理一次',
  async (kind) => {
    const db = createMemoryDatabase()
    migrateP6(db)
    try {
      const id = seed(db, kind, true)
      db.prepare(
        `INSERT INTO agent_runs(run_id,customer_id,status,prompt_version,model,created_at,updated_at)
      VALUES ('run1','C1','awaiting_approval','v1','scripted',?,?)`,
      ).run(now, now)
      const service = new ApprovalService(new SqliteApprovalRepository(db), new FrozenClock(now))
      const approval = await service.create({
        runId: 'run1',
        resourceType: kind,
        resourceId: id,
        reason: 'test',
        amountCents: 100,
        requestedBy: 'fixture',
      })
      const numberKey = kind === 'compensation' ? 'compensationNo' : 'protectionNo'
      const amountKey = kind === 'compensation' ? 'amountCents' : 'refundAmountCents'
      db.prepare(
        'INSERT INTO checkpoints(run_id,step_id,state_json,created_at) VALUES (?,?,?,?)',
      ).run(
        'run1',
        'approval',
        JSON.stringify({
          approvalId: approval.approvalId,
          approvalResourceType: kind,
          [numberKey]: id,
          [amountKey]: 100,
        }),
        now,
      )
      expect(
        (await service.decide({ role: 'supervisor' }, approval.approvalId, 'approved', 'run1'))
          .outcome,
      ).toBe('decided')
      const repo = new P6TaskRepository(db)
      db.exec(
        `CREATE TRIGGER p6_test_fail BEFORE INSERT ON p6_tasks BEGIN SELECT RAISE(ABORT,'test'); END`,
      )
      expect(() => repo.bridgeApprovals((key) => p6ApprovalCommand(db, key, config))).toThrow()
      expect(db.prepare('SELECT one_time_token AS token FROM approval_requests').get()).toEqual({
        token: approval.oneTimeToken,
      })
      expect(db.prepare('SELECT status FROM approval_execution_intents').get()).toEqual({
        status: 'pending',
      })
      db.exec('DROP TRIGGER p6_test_fail')
      expect(repo.bridgeApprovals((key) => p6ApprovalCommand(db, key, config))).toBe(1)
      expect(repo.bridgeApprovals((key) => p6ApprovalCommand(db, key, config))).toBe(0)
      const task = repo.claim('worker', 1000, limits)!
      expect(repo.beginPayment(task, task.input.plan.payment!, p6PrepareBusinessPayment)).toBe(true)
    } finally {
      db.close()
    }
  },
)

it('受理之后业务被取消时拒绝发送且不留下资金意图', () => {
  const db = createMemoryDatabase()
  migrateP6(db)
  try {
    seed(db, 'compensation')
    const repo = new P6TaskRepository(db)
    const payment = p6ReadyPayment(db, 'compensation', 'CP1', 'C1')
    repo.accept({
      customerId: 'C1',
      requestKey: 'key',
      kind: 'start',
      config,
      plan: { input: '', tool: 'compensation', payment },
    })
    db.exec("UPDATE compensations SET status = 'cancelled'")
    const claim = repo.claim('worker', 1000, limits)!
    expect(() => repo.beginPayment(claim, payment, p6PrepareBusinessPayment)).toThrow()
    expect(repo.effect(payment)).toBeUndefined()
  } finally {
    db.close()
  }
})
