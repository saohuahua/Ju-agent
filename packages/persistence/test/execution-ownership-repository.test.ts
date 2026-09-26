import { fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createMemoryDatabase, openDatabase } from '../src/db.js'
import { migrateExecutionOwnership } from '../src/execution-ownership-migration.js'
import { ExecutionOwnershipRepository } from '../src/execution-ownership-repository.js'

/** 进程就绪后由父进程同时放行 真实连接争用同一 SQLite 写锁 */
function racer(path: string, role: string) {
  const child = fork(
    fileURLToPath(new URL('./execution-ownership-racer.ts', import.meta.url)),
    [path, role],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  )
  let stderr = ''
  child.stderr?.on('data', (data) => {
    stderr += String(data)
  })
  let received: boolean | undefined
  let readyResolve!: () => void
  let readyReject!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const done = new Promise<boolean>((resolve, reject) => {
    child.on('message', (message: { ready?: boolean; won?: boolean }) => {
      if (message.ready) readyResolve()
      if (message.won !== undefined) received = message.won
    })
    child.on('error', (error) => {
      readyReject(error)
      reject(error)
    })
    child.on('exit', (code) => {
      if (code === 0 && received !== undefined) resolve(received)
      else {
        const error = new Error(`测试子进程异常退出 ${code} ${stderr}`)
        readyReject(error)
        reject(error)
      }
    })
  })
  return { child, ready, done }
}

it('两个进程的独立数据库连接竞争执行权只有一个获胜', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'execution-ownership-race-'))
  const path = join(dir, 'test.db')
  const db = openDatabase(path)
  migrateExecutionOwnership(db)
  new ExecutionOwnershipRepository(db).registerNew('refund:race')
  const a = racer(path, 'legacy')
  const b = racer(path, 'p6')
  try {
    await Promise.all([a.ready, b.ready])
    a.child.send('go')
    b.child.send('go')
    const results = await Promise.all([a.done, b.done])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(new ExecutionOwnershipRepository(db).get('refund:race')).toMatchObject(
      results[0] ? { owner: 'legacy', state: 'sending' } : { owner: 'p6', state: 'ready' },
    )
  } finally {
    a.child.kill()
    b.child.kill()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 20000)

it('取得许可后进程退出 重开连接仍不允许接管或重发', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'execution-ownership-exit-'))
  const path = join(dir, 'test.db')
  const db = openDatabase(path)
  migrateExecutionOwnership(db)
  new ExecutionOwnershipRepository(db).registerNew('refund:race')
  db.close()
  const a = racer(path, 'legacy')
  try {
    await a.ready
    a.child.send('go')
    expect(await a.done).toBe(true)
    const reopened = openDatabase(path)
    try {
      const ownership = new ExecutionOwnershipRepository(reopened)
      expect(ownership.get('refund:race')?.state).toBe('sending')
      expect(() => ownership.acquireLegacy('refund:race')).toThrow('执行权')
      expect(() =>
        ownership.takeoverWithCommand('refund:race', () => ({ commandId: 'another' })),
      ).toThrow('执行权')
    } finally {
      reopened.close()
    }
  } finally {
    a.child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
}, 20000)

it('历史未发送证据不足时保守冻结 成功及原幂等记录保持不变', () => {
  const db = createMemoryDatabase()
  try {
    db.exec(`INSERT INTO refunds
      (refund_no,return_no,order_no,amount_cents,currency,channel,status,idempotency_key,created_at,updated_at)
      VALUES ('R1','old','O1',100,'CNY','local','created','refund:old','now','now'),
        ('R2','success','O1',100,'CNY','local','succeeded','refund:success','now','now');
      INSERT INTO idempotency_records VALUES ('compensation:done','{"original":true}','now');`)
    const prior = db.prepare('SELECT * FROM idempotency_records').all()
    migrateExecutionOwnership(db)
    migrateExecutionOwnership(db)
    const ownership = new ExecutionOwnershipRepository(db)
    expect(ownership.get('refund:old')).toMatchObject({ owner: 'unassigned', state: 'unknown' })
    expect(ownership.get('refund:success')?.state).toBe('succeeded')
    expect(ownership.get('compensation:done')?.resultJson).toBe('{"original":true}')
    for (const key of ['refund:old', 'refund:missing', 'refund:success', 'compensation:done']) {
      expect(() => ownership.acquireLegacy(key)).toThrow()
      expect(() => ownership.takeoverWithCommand(key, () => ({ commandId: 'new' }))).toThrow()
    }
    expect(db.prepare('SELECT * FROM idempotency_records').all()).toEqual(prior)
  } finally {
    db.close()
  }
})

it('未知许可接受原渠道迟到成功 伪造许可与成功降级都被拒绝', () => {
  const db = createMemoryDatabase()
  try {
    migrateExecutionOwnership(db)
    const ownership = new ExecutionOwnershipRepository(db)
    ownership.registerNew('refund:test')
    const permit = ownership.acquireLegacy('refund:test')
    ownership.unknown(permit)
    expect(() => ownership.succeed({ ...permit, token: 'wrong' }, {})).toThrow()
    ownership.succeed(permit, { gatewayRefundId: 'confirmed' })
    const prior = ownership.get('refund:test')
    expect(() => ownership.unknown(permit)).toThrow()
    expect(() => ownership.registerNew('refund:test')).toThrow()
    expect(ownership.get('refund:test')).toEqual(prior)
  } finally {
    db.close()
  }
})

it('异步受理回调和事务内旧发送均被拒绝', () => {
  const db = createMemoryDatabase()
  try {
    migrateExecutionOwnership(db)
    const ownership = new ExecutionOwnershipRepository(db)
    ownership.registerNew('refund:test')
    expect(() =>
      ownership.takeoverWithCommand('refund:test', () =>
        Object.assign(Promise.resolve(), { commandId: 'invalid' }),
      ),
    ).toThrow('同步')
    expect(ownership.get('refund:test')?.owner).toBe('legacy')
    expect(() => db.transaction(() => ownership.acquireLegacy('refund:test'))()).toThrow()
    expect(ownership.get('refund:test')?.state).toBe('ready')
  } finally {
    db.close()
  }
})
