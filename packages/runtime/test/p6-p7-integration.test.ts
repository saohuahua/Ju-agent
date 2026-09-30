import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../../persistence/src/db.js'
import { P6TaskRepository } from '../../persistence/src/p6-task-repository.js'
import { P7Ledger } from '../../persistence/src/p7-ledger.js'
import { p6ConfigFromP7 } from '../src/p6-config-snapshot.js'
import { snapshot } from './p7-fixtures.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const evidence = join(
  root,
  'docs/experiments/p6-p7-results',
  new Date().toISOString().replaceAll(':', '-'),
)

/** 两个真实进程共享磁盘任务与账本 恢复不能抹去第一次调用费用 */
describe('P6 与 P7 跨进程集成', () => {
  it.each(['during-model', 'after-model-response', 'after-model-checkpoint'])(
    '%s 后恢复保留费用并跳过已确认调用',
    (fault) => {
      const directory = join(evidence, fault)
      mkdirSync(directory, { recursive: true })
      const path = join(directory, 'application.db')
      const db = openDatabase(path)
      try {
        const repo = new P6TaskRepository(db)
        const task = repo.accept({
          customerId: 'C1001',
          requestKey: 'joint',
          kind: 'start',
          source: 'sim',
          config: p6ConfigFromP7(snapshot()),
          plan: { input: '联合恢复验证', tool: 'read_only' },
        })
        const run = (mode: string) =>
          spawnSync(
            process.execPath,
            [
              '--import',
              'tsx',
              join(root, 'packages/runtime/test/fixtures/p6-p7-process.ts'),
              path,
              mode,
            ],
            { cwd: root, encoding: 'utf8', timeout: 15000 },
          )
        const first = run(fault)
        expect(first.status, first.stderr).toBe(73)
        const next = run('recover')
        expect(next.status, next.stderr).toBe(0)
        expect(repo.get(task.taskId)?.status).toBe('completed')
        const rows = new P7Ledger(db).rows()
        expect(rows).toHaveLength(fault === 'after-model-checkpoint' ? 1 : 2)
        expect(rows.filter((row) => row.status === 'held')).toHaveLength(
          fault === 'during-model' ? 1 : 0,
        )
        writeFileSync(
          join(directory, 'evidence.json'),
          JSON.stringify(
            {
              fault,
              first: { status: first.status, stdout: first.stdout, stderr: first.stderr },
              next: { status: next.status, stdout: next.stdout, stderr: next.stderr },
              task: repo.get(task.taskId),
              calls: rows,
              totals: new P7Ledger(db).totals(),
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

  it('连续强退耗尽任务上限后不再调用模型', () => {
    const directory = join(evidence, 'attempt-limit')
    mkdirSync(directory, { recursive: true })
    const path = join(directory, 'application.db')
    const db = openDatabase(path)
    try {
      const repo = new P6TaskRepository(db)
      const task = repo.accept({
        customerId: 'C1001',
        requestKey: 'limit',
        kind: 'start',
        config: p6ConfigFromP7(snapshot()),
        plan: { input: '强退上限', tool: 'read_only' },
      })
      for (let index = 0; index < 3; index++) {
        const result = spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            join(root, 'packages/runtime/test/fixtures/p6-p7-process.ts'),
            path,
            'during-model',
          ],
          { cwd: root, encoding: 'utf8', timeout: 15000 },
        )
        expect(result.status, result.stderr).toBe(index < 2 ? 73 : 0)
      }
      expect(new P7Ledger(db).rows()).toHaveLength(2)
      expect(repo.get(task.taskId)?.status).toBe('call_failed')
      writeFileSync(
        join(directory, 'evidence.json'),
        JSON.stringify({ task: repo.get(task.taskId), calls: new P7Ledger(db).rows() }, null, 2),
      )
    } finally {
      db.close()
    }
  }, 30000)
})
