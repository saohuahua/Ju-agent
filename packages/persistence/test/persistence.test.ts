/**
 * 持久化层测试
 *
 * 事件序号唯一与递增 夹具重置确定性 乐观锁 幂等记录 租约抢占
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryDatabase, type SqliteDatabase } from '../src/db.js'
import { loadFixture, BASELINE_FROZEN_TIME } from '../src/fixtures.js'
import {
  SqliteAgentRunRepository,
  SqliteEventRepository,
  SqliteIdempotencyRepository,
  SqliteLeaseRepository,
  SqliteOrderRepository,
  SqliteReturnRepository,
  SqliteBusinessNoGenerator,
  queryTable,
} from '../src/index.js'

let db: SqliteDatabase

beforeEach(() => {
  db = createMemoryDatabase()
})

describe('夹具', () => {
  it('基线数据完整载入', () => {
    loadFixture(db)
    expect(queryTable(db, 'orders', { order_no: 'SO-2026-0001' })).toHaveLength(1)
    expect(queryTable(db, 'shipments', { status: 'lost' })).toHaveLength(1)
    expect(queryTable(db, 'return_requests')).toHaveLength(1)
  })

  it('重复载入结果一致 重置语义成立', () => {
    loadFixture(db)
    const ordersFirst = queryTable(db, 'orders').length
    loadFixture(db)
    const ordersSecond = queryTable(db, 'orders').length
    expect(ordersFirst).toBe(ordersSecond)
  })

  it('补丁定向覆盖订单状态', () => {
    loadFixture(db, [
      { table: 'orders', where: { order_no: 'SO-2026-0003' }, set: { status: 'completed' } },
    ])
    const row = queryTable(db, 'orders', { order_no: 'SO-2026-0003' })[0]
    expect(row?.status).toBe('completed')
  })

  it('补丁表白名单之外的表被拒绝', () => {
    expect(() =>
      loadFixture(db, [
        { table: 'audit_logs' as never, where: { id: 1 }, set: { action: 'tamper' } },
      ]),
    ).toThrow()
  })
})

describe('事件存储', () => {
  it('同一 run 的序号单调递增且不重复', async () => {
    loadFixture(db)
    const repo = new SqliteEventRepository(db)
    const seq1 = await repo.append('run_a', 'run.started', { a: 1 })
    const seq2 = await repo.append('run_a', 'run.paused', { a: 2 })
    const seq3 = await repo.append('run_a', 'run.resumed', { a: 3 })
    expect([seq1, seq2, seq3]).toEqual([1, 2, 3])
    const events = await repo.listByRun('run_a', 2)
    expect(events.map((e) => e.sequence)).toEqual([2, 3])
  })

  it('不同 run 序号独立', async () => {
    const repo = new SqliteEventRepository(db)
    await repo.append('run_a', 'run.started', {})
    const seqB = await repo.append('run_b', 'run.started', {})
    expect(seqB).toBe(1)
  })

  it('run 与 sequence 组合唯一约束生效', () => {
    expect(() => {
      db.prepare(
        'INSERT INTO agent_events (run_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run('run_a', 1, 'run.started', '{}', BASELINE_FROZEN_TIME)
      db.prepare(
        'INSERT INTO agent_events (run_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run('run_a', 1, 'run.started', '{}', BASELINE_FROZEN_TIME)
    }).toThrow()
  })
})

describe('单号生成', () => {
  it('计数器接续历史记录并原子递增', () => {
    loadFixture(db)
    const generator = new SqliteBusinessNoGenerator(db, 2026)
    expect(generator.nextNo('RT')).toBe('RT-2026-0002')
    expect(generator.nextNo('RT')).toBe('RT-2026-0003')
    expect(generator.nextNo('RF')).toBe('RF-2026-0002')
  })
})

describe('乐观锁', () => {
  it('版本冲突时更新被拒绝', async () => {
    loadFixture(db)
    const repo = new SqliteReturnRepository(db)
    const record = await repo.findByReturnNo('RT-2026-0001')
    expect(record).not.toBeNull()
    if (!record) return
    record.status = 'cancelled'
    await repo.update(record)
    // 旧版本对象再更新 同版本号冲突
    record.status = 'completed'
    await expect(repo.update(record)).rejects.toThrow('乐观锁冲突')
  })
})

describe('幂等记录', () => {
  it('同键重复写入不报错且保留首条', async () => {
    const repo = new SqliteIdempotencyRepository(db)
    await repo.record('refund:RT-1', { refundNo: 'RF-1' })
    await repo.record('refund:RT-1', { refundNo: 'RF-DIFFERENT' })
    const found = await repo.find('refund:RT-1')
    expect(found?.result.refundNo).toBe('RF-1')
  })
})

describe('租约', () => {
  it('他人持有未过期租约时抢占失败', async () => {
    const repo = new SqliteLeaseRepository(db)
    expect(await repo.acquire('worker-1', 'workflow_run', 'run_a', 60_000)).toBe(true)
    expect(await repo.acquire('worker-2', 'workflow_run', 'run_a', 60_000)).toBe(false)
  })

  it('租约过期后可被接管', async () => {
    const repo = new SqliteLeaseRepository(db)
    expect(await repo.acquire('worker-1', 'workflow_run', 'run_a', 50)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(await repo.acquire('worker-2', 'workflow_run', 'run_a', 60_000)).toBe(true)
  })

  it('持有人可以续期', async () => {
    const repo = new SqliteLeaseRepository(db)
    expect(await repo.acquire('worker-1', 'workflow_run', 'run_a', 60_000)).toBe(true)
    expect(await repo.acquire('worker-1', 'workflow_run', 'run_a', 120_000)).toBe(true)
  })
})

describe('运行仓储', () => {
  it('创建与状态更新往返一致', async () => {
    const repo = new SqliteAgentRunRepository(db)
    const record = {
      runId: 'run_test01',
      customerId: 'C1001',
      status: 'created' as const,
      intent: null,
      promptVersion: 'v1',
      model: 'scripted',
      error: null,
      faultPlan: [],
      source: 'customer' as const,
      createdAt: BASELINE_FROZEN_TIME,
      updatedAt: BASELINE_FROZEN_TIME,
    }
    await repo.create(record)
    await repo.update({ ...record, status: 'running', intent: 'submit_refund_only' })
    const found = await repo.findById('run_test01')
    expect(found?.status).toBe('running')
    expect(found?.intent).toBe('submit_refund_only')
    expect(found?.source).toBe('customer')
  })
})

describe('订单仓储', () => {
  it('商品 JSON 列往返无损', async () => {
    loadFixture(db)
    const repo = new SqliteOrderRepository(db)
    const order = await repo.findByOrderNo('SO-2026-0001')
    expect(order?.items).toHaveLength(2)
    expect(order?.items[0]?.title).toBe('降噪无线耳机')
  })
})
