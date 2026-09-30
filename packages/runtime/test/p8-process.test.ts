import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../../persistence/src/db.js'
import { P8Investigation } from '../src/p8-investigation.js'
import { p8OfflineTransport } from '../../eval/src/p8-offline-fixture.js'
import { p8Report } from '../../eval/src/p8-offline-report.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const archive = join(
  root,
  'docs/experiments/p8-offline-investigation-evidence',
  `process-${new Date().toISOString().replaceAll(':', '-')}`,
)

/** 真正子进程退出后另启进程 不用同进程对象重建替代 */
function launch(path: string, phase: string) {
  return new Promise<{ code: number | null; output: string }>((resolveExit, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'packages/runtime/test/fixtures/p8-process.ts', path, phase],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('P8 子进程超时'))
    }, 15000)
    child.stdout.on('data', (data) => {
      output += String(data)
    })
    child.stderr.on('data', (data) => {
      output += String(data)
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      resolveExit({ code, output })
    })
  })
}

describe('P8 跨进程持久恢复', () => {
  it('模型已记账但分支未确认时保守停止且不换号重发', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'p8-unconfirmed-'))
    const path = join(temporary, 'application.db')
    const folder = join(archive, 'model-unconfirmed')
    mkdirSync(folder, { recursive: true })
    const first = await launch(path, 'model-unconfirmed')
    expect(first.code, first.output).toBe(71)
    const db = openDatabase(path)
    try {
      const runtime = new P8Investigation(db, {
        transport: (_snapshot, role) => p8OfflineTransport(role),
      })
      const row = db.prepare('SELECT parent_task_id AS id FROM p8_investigations').get() as {
        id: string
      }
      const before = p8Report(runtime, row.id)
      expect(before.calls).toHaveLength(1)
      expect(before.branches.filter(Boolean)).toHaveLength(0)
      expect(before.steps).toHaveLength(1)
      const second = await launch(path, 'resume')
      expect(second.code, second.output).toBe(0)
      const after = p8Report(runtime, row.id)
      expect(after.calls).toHaveLength(2)
      expect(after.conclusion?.recommendation).toBe('human_review')
      expect(after.branches[0]?.error).toContain('先前调用未确认')
      expect(after.branches[1]?.status).toBe('confirmed')
      expect(after.metrics.settledMicroYuan).toBe(20)
      expect(
        after.events.filter(
          (event) => (event as { event_key: string }).event_key === 'step:p8-conclusion',
        ),
      ).toHaveLength(1)
      await db.backup(join(folder, 'application.db'))
      writeFileSync(
        join(folder, 'evidence.json'),
        JSON.stringify(
          { first, second, before, after, retransmittedUnconfirmedCall: false },
          null,
          2,
        ),
      )
    } finally {
      db.close()
    }
  }, 30000)

  it.each(['accepted', 'one-confirmed', 'both-confirmed'] as const)(
    '%s 后真实退出再恢复',
    async (phase) => {
      const temporary = mkdtempSync(join(tmpdir(), 'p8-recovery-'))
      const path = join(temporary, 'application.db')
      const folder = join(archive, phase)
      mkdirSync(folder, { recursive: true })
      const first = await launch(path, phase)
      expect(first.code, first.output).toBe(71)
      const db = openDatabase(path)
      try {
        const runtime = new P8Investigation(db, {
          transport: (_snapshot, role) => p8OfflineTransport(role),
        })
        const row = db.prepare('SELECT parent_task_id AS id FROM p8_investigations').get() as {
          id: string
        }
        const before = p8Report(runtime, row.id)
        const count = phase === 'accepted' ? 0 : phase === 'one-confirmed' ? 1 : 2
        expect(before.tasks).toHaveLength(3)
        expect(before.tasks.every((task) => task.customerId === before.input.customerId)).toBe(true)
        expect(before.branches.filter(Boolean)).toHaveLength(count)
        expect(before.calls).toHaveLength(count)
        expect(before.conclusion).toBeUndefined()
        const business = () =>
          ['refunds', 'return_requests', 'approval_requests', 'p6_effects'].map((table) =>
            db.prepare(`SELECT * FROM ${table}`).all(),
          )
        const originalBusiness = business()
        const second = await launch(path, 'resume')
        expect(second.code, second.output).toBe(0)
        const after = p8Report(runtime, row.id)
        expect(after.parent.status).toBe('completed')
        expect(after.conclusion?.recommendation).toBe('controlled_review')
        expect(after.branches.every((result) => result?.status === 'confirmed')).toBe(true)
        expect(after.calls).toHaveLength(2)
        expect(after.calls.filter((call) => call.status === 'settled')).toHaveLength(2)
        expect(after.metrics.settledMicroYuan).toBe(20)
        expect(after.input).toEqual(before.input)
        expect(after.tasks.map((task) => task.taskId)).toEqual(
          before.tasks.map((task) => task.taskId),
        )
        for (const branch of before.branches.filter(Boolean))
          expect(after.branches.find((item) => item?.taskId === branch!.taskId)).toEqual(branch)
        expect(after.steps).toHaveLength(5)
        expect(
          after.events.filter(
            (event) => (event as { event_key: string }).event_key === 'step:p8-conclusion',
          ),
        ).toHaveLength(1)
        expect(business()).toEqual(originalBusiness)
        const third = await launch(path, 'resume')
        expect(third.code, third.output).toBe(0)
        expect(p8Report(runtime, row.id)).toEqual(after)
        await db.backup(join(folder, 'application.db'))
        writeFileSync(
          join(folder, 'evidence.json'),
          JSON.stringify(
            {
              phase,
              temporaryDatabase: path,
              first,
              second,
              third,
              before,
              after,
              originalBusiness,
              finalBusiness: business(),
              repeatedConfirmedCalls: 0,
            },
            null,
            2,
          ),
        )
      } finally {
        db.close()
      }
    },
    30000,
  )
})
