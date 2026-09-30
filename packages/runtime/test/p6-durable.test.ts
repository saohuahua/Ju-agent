import { describe, expect, it } from 'vitest'
import { createMemoryDatabase } from '../../persistence/src/db.js'
import { migrateP6 } from '../../persistence/src/p6-migration.js'
import { P6TaskRepository } from '../../persistence/src/p6-task-repository.js'
import { P6Worker } from '../src/p6-worker.js'
import type { P6CommandInput } from '../../contracts/src/p6-durable.js'

const limits = { global: 2, customer: 1, provider: 2, tool: 2 }
function input(key = 'r1', customer = 'C1'): P6CommandInput {
  return {
    requestKey: key,
    customerId: customer,
    kind: 'start',
    config: {
      snapshotId: 'v1',
      provider: 'scripted',
      model: 'scripted',
      promptVersion: 'v1',
      value: {},
    },
    plan: {
      input: 'test',
      tool: 'refund',
      payment: {
        businessKey: 'business-1',
        resourceId: 'refund-1',
        amountCents: 100,
        currency: 'CNY',
      },
    },
  }
}

/** 每个用例关闭自己的数据库 不依赖同一对象反复抛错来证明进程恢复 */
function fixture(now = Date.now) {
  const db = createMemoryDatabase()
  migrateP6(db)
  return { db, repo: new P6TaskRepository(db, now) }
}

describe('P6 持久命令与围栏', () => {
  it('同键重复受理返回原标识 异参冲突且不创建多余运行', () => {
    const { db, repo } = fixture()
    try {
      const first = repo.accept(input())
      expect(repo.accept(input()).taskId).toBe(first.taskId)
      expect(() => repo.accept({ ...input(), plan: { input: 'changed', tool: 'refund' } })).toThrow(
        '冲突',
      )
      expect(db.prepare('SELECT count(*) AS n FROM agent_runs').get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('受理事务失败不残留运行或命令', () => {
    const { db, repo } = fixture()
    try {
      db.exec(
        `CREATE TRIGGER p6_fail BEFORE INSERT ON p6_tasks BEGIN SELECT RAISE(ABORT,'test'); END`,
      )
      expect(() => repo.accept(input())).toThrow()
      expect(db.prepare('SELECT count(*) AS n FROM agent_runs').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT count(*) AS n FROM p6_commands').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })

  it('过期代次不能续约完成释放或写检查点', () => {
    let now = 1000
    const { db, repo } = fixture(() => now)
    try {
      repo.accept(input())
      const old = repo.claim('old', 100, limits)!
      now += 101
      const next = repo.claim('new', 100, limits)!
      expect(next.generation).toBe(old.generation + 1)
      expect(repo.renew(old, 100)).toBe(false)
      expect(() => repo.finish(old, 'completed')).toThrow()
      expect(() => repo.release(old, 'retry', 0)).toThrow()
      expect(() => repo.checkpoint(old, 'model', {})).toThrow()
      expect(() => repo.beginPayment(old, input().plan.payment!)).toThrow()
      repo.finish(next, 'completed')
    } finally {
      db.close()
    }
  })

  it.each(['global', 'customer', 'provider', 'tool'] as const)(
    '认领事务执行 %s 并发上限',
    (dimension) => {
      const { db, repo } = fixture()
      try {
        repo.accept(input())
        repo.accept(input('r2', dimension === 'customer' ? 'C1' : 'C2'))
        const cap = { global: 3, customer: 3, provider: 3, tool: 3, [dimension]: 1 }
        expect(repo.claim('a', 1000, cap)).toBeDefined()
        expect(repo.claim('b', 1000, cap)).toBeUndefined()
      } finally {
        db.close()
      }
    },
  )

  it('跨运行共享业务键 已确认副作用不重复发送或记账', () => {
    const { db, repo } = fixture()
    try {
      repo.accept(input())
      const first = repo.claim('a', 1000, limits)!
      const payment = input().plan.payment!
      expect(repo.beginPayment(first, payment)).toBe(true)
      let applied = 0
      repo.settle(first, payment, { status: 'succeeded', transactionId: 'tx' }, () => {
        applied++
      })
      repo.finish(first, 'completed')
      repo.accept(input('new-run'))
      const second = repo.claim('b', 1000, limits)!
      expect(second.runId).not.toBe(first.runId)
      expect(repo.beginPayment(second, payment)).toBe(false)
      repo.settle(second, payment, { status: 'succeeded', transactionId: 'tx' }, () => {
        applied++
      })
      expect(applied).toBe(1)
      expect(() => repo.effect({ ...payment, amountCents: 200 })).toThrow('冲突')
    } finally {
      db.close()
    }
  })

  it('业务记账异常回滚终态与检查点 恢复只能查询', () => {
    const { db, repo } = fixture()
    try {
      repo.accept(input())
      const claim = repo.claim('a', 1000, limits)!
      const payment = input().plan.payment!
      repo.beginPayment(claim, payment)
      expect(() =>
        repo.settle(claim, payment, { status: 'succeeded', transactionId: 'tx' }, () => {
          db.prepare(`UPDATE agent_runs SET status = 'completed' WHERE run_id = ?`).run(claim.runId)
          throw new Error('记账失败')
        }),
      ).toThrow()
      expect(repo.effect(payment)?.status).toBe('sending')
      expect(repo.step(claim.taskId, 'payment')).toBeUndefined()
      expect(db.prepare('SELECT status FROM agent_runs').get()).toEqual({ status: 'created' })
      expect(repo.beginPayment(claim, payment)).toBe(false)
    } finally {
      db.close()
    }
  })

  it('取消校验归属且发送前不会产生资金意图', async () => {
    const { db, repo } = fixture()
    try {
      const task = repo.accept(input())
      expect(repo.cancel(task.taskId, 'other')).toBe(false)
      expect(repo.cancel(task.taskId, 'C1')).toBe(true)
      let calls = 0
      const worker = new P6Worker(
        repo,
        {
          model: async () => {
            calls++
            return {}
          },
          read: async () => ({}),
          payment: {
            execute: async () => {
              calls++
              return { status: 'unknown', reason: 'test' }
            },
            query: async () => ({ status: 'not_found' }),
          },
          applyPayment: () => {},
        },
        { owner: 'a', leaseMs: 1000, callTimeoutMs: 100, maxAttempts: 2, retryDelayMs: 0, limits },
      )
      await worker.runOnce()
      expect(repo.get(task.taskId)?.status).toBe('cancelled')
      expect(calls).toBe(0)
    } finally {
      db.close()
    }
  })

  it('未知资金即使手动恢复也只查询 不重放且查询无记录仍未知', async () => {
    const { db, repo } = fixture()
    try {
      const task = repo.accept(input())
      let sends = 0
      let queries = 0
      const worker = new P6Worker(
        repo,
        {
          model: async () => ({}),
          read: async () => ({}),
          payment: {
            execute: async () => {
              sends++
              return { status: 'unknown', reason: 'test' }
            },
            query: async () => {
              queries++
              return { status: 'not_found' }
            },
          },
          applyPayment: () => {},
        },
        { owner: 'a', leaseMs: 1000, callTimeoutMs: 100, maxAttempts: 2, retryDelayMs: 0, limits },
      )
      await worker.runOnce()
      expect(repo.get(task.taskId)?.status).toBe('needs_confirmation')
      expect(await worker.runOnce()).toBe(false)
      repo.reconcile(task.taskId)
      await worker.runOnce()
      expect(repo.get(task.taskId)?.status).toBe('needs_confirmation')
      expect({ sends, queries }).toEqual({ sends: 1, queries: 1 })
    } finally {
      db.close()
    }
  })

  it('检查点事件游标重放稳定 不重复确认事件', () => {
    const { db, repo } = fixture()
    try {
      const task = repo.accept(input())
      const claim = repo.claim('a', 1000, limits)!
      repo.checkpoint(claim, 'model', { complete: true })
      repo.checkpoint(claim, 'model', { complete: true })
      const first = repo.events(task.taskId)
      repo.checkpoint(claim, 'read', {})
      const next = repo.events(task.taskId, first[0]!.cursor)
      expect(first).toHaveLength(1)
      expect(next.map((event) => event.eventKey)).toEqual(['step:read'])
    } finally {
      db.close()
    }
  })
})
