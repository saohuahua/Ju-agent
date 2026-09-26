import { fork, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { openDatabase } from '../../persistence/src/db.js'
import { P7Ledger } from '../../persistence/src/p7-ledger.js'
import { migrateP7 } from '../../persistence/src/p7-migration.js'
import { snapshot } from './p7-fixtures.js'

function message(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onExit = () => reject(new Error('子进程过早退出'))
    child.once('exit', onExit)
    child.once('error', reject)
    child.once('message', (value) => {
      child.off('exit', onExit)
      child.off('error', reject)
      resolve(value)
    })
  })
}

it('两个独立进程竞争累计预算且重启保留预占和不可变快照', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'p7-budget-'))
  const path = join(directory, 'budget.db')
  const children: ChildProcess[] = []
  try {
    const initial = openDatabase(path)
    migrateP7(initial)
    migrateP7(initial)
    initial.close()
    const fixture = fileURLToPath(new URL('./p7-budget-child.ts', import.meta.url))
    for (let i = 0; i < 2; i++)
      children.push(
        fork(fixture, [path], {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        }),
      )
    expect(await Promise.all(children.map(message))).toEqual(['ready', 'ready'])
    const responses = children.map(message)
    const exits = children.map(
      (child) => new Promise<void>((resolve) => child.once('exit', () => resolve())),
    )
    for (const child of children) child.send('reserve')
    expect((await Promise.all(responses)).sort()).toEqual(['BUDGET_EXCEEDED', 'reserved'])
    await Promise.all(exits)
    const restored = openDatabase(path)
    try {
      const ledger = new P7Ledger(restored)
      expect(ledger.totals()).toEqual({ committed: 60000000, active: 1 })
      expect(() =>
        ledger.reserve(
          {
            callId: 'after-restart',
            operationId: 'after-restart',
            runId: 'next',
            purpose: 'judge',
            attempt: 1,
          },
          snapshot(),
          60000000,
        ),
      ).toThrow('BUDGET_EXCEEDED')
      expect(() =>
        restored.prepare('UPDATE p7_run_snapshots SET version = ?').run('changed'),
      ).toThrow('immutable snapshot')
      const row = ledger.rows()[0]!
      ledger.finish(row.call_id, 10, { inputTokens: 10, outputTokens: 0 }, 'reconciled')
      ledger.finish(row.call_id, 10, { inputTokens: 10, outputTokens: 0 }, 'reconciled')
      expect(() => ledger.finish(row.call_id, 0, null, 'free')).toThrow('CONFIG')
      expect(ledger.totals().committed).toBe(10)
    } finally {
      restored.close()
    }
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill()
    // 只清理本用例创建的文件 不递归删除目录
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
    rmdirSync(directory)
  }
}, 15000)
