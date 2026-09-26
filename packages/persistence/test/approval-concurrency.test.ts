import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ApprovalService,
  AuditService,
  FrozenClock,
  HumanHandoverService,
  RunService,
} from '@aftersales/domain'
import { openDatabase, clearBusinessData, type SqliteDatabase } from '../src/db.js'
import { SqliteApprovalRepository } from '../src/business-repositories.js'
import {
  SqliteAgentRunRepository,
  SqliteEventRepository,
  SqliteAuditRepository,
} from '../src/infrastructure-repositories.js'
import { SqliteApprovalExecutionRepository } from '../src/approval-execution-repository.js'
import { SqliteCaseClosureRepository } from '../src/case-closure-repository.js'

const resources: Array<{ directory: string; connections: SqliteDatabase[] }> = []
const supervisor = { role: 'supervisor' as const }

afterEach(() => {
  for (const resource of resources.splice(0)) {
    for (const connection of resource.connections) if (connection.open) connection.close()
    // 只删除本用例创建的数据库文件 不对临时目录执行递归删除
    for (const name of ['approval.db', 'approval.db-wal', 'approval.db-shm'])
      rmSync(join(resource.directory, name), { force: true })
    rmdirSync(resource.directory)
  }
})

/** 两个连接和两套服务共享同一个磁盘库以暴露读后写竞争 */
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'youju-approval-'))
  const db1 = openDatabase(join(directory, 'approval.db'))
  const db2 = openDatabase(join(directory, 'approval.db'))
  const resource = { directory, connections: [db1, db2] }
  resources.push(resource)
  const clock = new FrozenClock('2026-09-20T12:00:00Z')
  const repo1 = new SqliteApprovalRepository(db1)
  const repo2 = new SqliteApprovalRepository(db2)
  const service1 = new ApprovalService(repo1, clock)
  const service2 = new ApprovalService(repo2, clock)
  const runs1 = new RunService(
    new SqliteAgentRunRepository(db1),
    new SqliteEventRepository(db1),
    clock,
  )
  const runs2 = new RunService(
    new SqliteAgentRunRepository(db2),
    new SqliteEventRepository(db2),
    clock,
  )
  const run = await runs1.start({ customerId: 'C1001', model: 'fixture', promptVersion: 'test' })
  await runs1.transition(run.runId, 'running')
  await runs1.transition(run.runId, 'awaiting_approval')
  const approval = await service1.create({
    runId: run.runId,
    resourceType: 'return_request',
    resourceId: 'RT-fixture',
    reason: '竞争验收',
    amountCents: 600000,
    requestedBy: 'workflow',
  })
  return {
    resource,
    db1,
    db2,
    clock,
    repo1,
    repo2,
    service1,
    service2,
    runs1,
    runs2,
    run,
    approval,
  }
}

describe('审批数据库原子边界', () => {
  it('读取后断点变化或审批到期时数据库写入再次拦截', async () => {
    const f = await fixture()
    const checkpoint = f.db1.prepare(
      'INSERT INTO checkpoints (run_id, step_id, state_json, created_at) VALUES (?, ?, ?, ?)',
    )
    const first = checkpoint.run(f.run.runId, 'approval', '{}', f.clock.now().toISOString())
    checkpoint.run(f.run.runId, 'approval', '{}', f.clock.now().toISOString())
    expect(
      await f.repo1.decidePending({
        approvalId: f.approval.approvalId,
        decision: 'approved',
        decidedBy: 'supervisor',
        runId: f.run.runId,
        checkpointId: Number(first.lastInsertRowid),
        now: f.clock.now().toISOString(),
      }),
    ).toBeNull()
    expect(
      await f.repo2.decidePending({
        approvalId: f.approval.approvalId,
        decision: 'approved',
        decidedBy: 'supervisor',
        now: f.approval.expiresAt,
      }),
    ).toBeNull()
    expect((await f.repo1.findById(f.approval.approvalId))?.status).toBe('pending')
  })

  it('两个独立连接同时决定只允许一个生效并只保存一个执行意图', async () => {
    const f = await fixture()
    const results = await Promise.all([
      f.service1.decide(supervisor, f.approval.approvalId, 'approved', f.run.runId),
      f.service2.decide(supervisor, f.approval.approvalId, 'rejected', f.run.runId),
    ])
    expect(results.map((result) => result.outcome).sort()).toEqual(['already_decided', 'decided'])
    const winner = results.find((result) => result.outcome === 'decided')!
    expect(await f.repo2.findById(f.approval.approvalId)).toMatchObject({
      status: winner.approval.status,
    })
    const intents = new SqliteApprovalExecutionRepository(f.db2).list()
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({
      decision: winner.approval.status,
      status: 'pending',
      runId: f.run.runId,
    })
  })

  it('相同令牌的并发消费只有一个成功 空令牌与原令牌不能重放', async () => {
    const f = await fixture()
    await f.service1.decide(supervisor, f.approval.approvalId, 'approved')
    const args = [f.approval.oneTimeToken, 'return_request', 'RT-fixture'] as const
    const results = await Promise.all([
      f.service1.consumeToken(...args),
      f.service2.consumeToken(...args),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect((await f.service1.consumeToken(...args)).ok).toBe(false)
    expect((await f.service1.consumeToken('', 'return_request', 'RT-fixture')).ok).toBe(false)
    expect((await f.repo2.findById(f.approval.approvalId))?.oneTimeToken).toBe('')
  })

  it('角色 归属 运行状态 过期与资源绑定失败均不消耗有效授权', async () => {
    const f = await fixture()
    await expect(
      f.service1.decide({ role: 'operator' }, f.approval.approvalId, 'approved'),
    ).rejects.toMatchObject({ shape: { code: 'AUTHORIZATION_DENIED' } })
    expect(
      (await f.service1.decide(supervisor, f.approval.approvalId, 'approved', 'run_other')).outcome,
    ).toBe('conflict')
    await f.runs1.transition(f.run.runId, 'cancelled')
    expect(
      (await f.service1.decide(supervisor, f.approval.approvalId, 'approved', f.run.runId)).outcome,
    ).toBe('conflict')
    expect((await f.repo1.findById(f.approval.approvalId))?.status).toBe('pending')
    expect(new SqliteApprovalExecutionRepository(f.db1).list()).toEqual([])

    await f.service1.decide(supervisor, f.approval.approvalId, 'approved')
    expect(
      (await f.service1.consumeToken(f.approval.oneTimeToken, 'compensation', 'RT-fixture')).ok,
    ).toBe(false)
    f.clock.advanceTo(f.approval.expiresAt)
    expect(
      await f.repo2.consumeToken(
        f.approval.approvalId,
        f.approval.oneTimeToken,
        'return_request',
        'RT-fixture',
        f.clock.now().toISOString(),
      ),
    ).toBe(false)
    expect((await f.repo1.findById(f.approval.approvalId))?.oneTimeToken).toBe(
      f.approval.oneTimeToken,
    )
  })

  it('执行意图写入失败时审批决定一起回滚', async () => {
    const f = await fixture()
    f.db1.exec(`CREATE TRIGGER reject_intent BEFORE INSERT ON approval_execution_intents
      BEGIN SELECT RAISE(ABORT, 'injected intent failure'); END`)
    await expect(
      f.service1.decide(supervisor, f.approval.approvalId, 'approved', f.run.runId),
    ).rejects.toThrow('injected intent failure')
    expect((await f.repo2.findById(f.approval.approvalId))?.status).toBe('pending')
    expect(new SqliteApprovalExecutionRepository(f.db2).list()).toEqual([])
  })

  it('重新打开数据库仍能发现待执行意图且竞争认领只有一个成功', async () => {
    const f = await fixture()
    await f.service1.decide(supervisor, f.approval.approvalId, 'approved', f.run.runId)
    f.db1.close()
    f.db2.close()
    const reopened1 = openDatabase(join(f.resource.directory, 'approval.db'))
    const reopened2 = openDatabase(join(f.resource.directory, 'approval.db'))
    f.resource.connections.push(reopened1, reopened2)
    const first = new SqliteApprovalExecutionRepository(reopened1)
    const second = new SqliteApprovalExecutionRepository(reopened2)
    expect(first.find(f.approval.approvalId)?.status).toBe('pending')
    expect([
      first.claim(f.approval.approvalId, f.clock.now().toISOString()),
      second.claim(f.approval.approvalId, f.clock.now().toISOString()),
    ]).toEqual([true, false])
    first.finish(f.approval.approvalId, 'completed', f.clock.now().toISOString())
    expect(second.claim(f.approval.approvalId, f.clock.now().toISOString())).toBe(false)
    expect(() => clearBusinessData(reopened1)).not.toThrow()
  })

  it('两个连接同时接管仅写入一条接管事件', async () => {
    const f = await fixture()
    await f.runs1.transition(f.run.runId, 'escalated')
    const first = new HumanHandoverService(
      f.runs1,
      new AuditService(new SqliteAuditRepository(f.db1), f.clock),
      new SqliteCaseClosureRepository(f.db1), f.clock,
    )
    const second = new HumanHandoverService(
      f.runs2,
      new AuditService(new SqliteAuditRepository(f.db2), f.clock),
      new SqliteCaseClosureRepository(f.db2), f.clock,
    )
    const results = await Promise.allSettled([
      first.takeOver({ role: 'operator' }, f.run.runId),
      second.takeOver(supervisor, f.run.runId),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ shape: { code: 'CONFLICT' } })
    expect(
      (await new SqliteEventRepository(f.db1).listByRun(f.run.runId)).filter(
        (event) => event.type === 'run.handover',
      ),
    ).toHaveLength(1)
  })
})
