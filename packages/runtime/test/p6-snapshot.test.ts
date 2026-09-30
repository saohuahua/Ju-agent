import { expect, it } from 'vitest'
import { p6ConfigFromP7 } from '../src/p6-config-snapshot.js'
import { restoreP7Snapshot } from '../src/p7-snapshot.js'
import { snapshot } from './p7-fixtures.js'
import { createMemoryDatabase } from '../../persistence/src/db.js'
import { migrateP6 } from '../../persistence/src/p6-migration.js'
import { P6TaskRepository } from '../../persistence/src/p6-task-repository.js'

it('P6 保存并恢复完整 P7 快照 不重新生成版本或读取新配置', () => {
  const original = snapshot()
  const config = p6ConfigFromP7(original)
  expect(config.snapshotId).toBe(original.version)
  expect(config.value).not.toBe(original)
  const db = createMemoryDatabase()
  migrateP6(db)
  try {
    const repo = new P6TaskRepository(db)
    const task = repo.accept({
      customerId: 'C1',
      requestKey: 'r1',
      kind: 'start',
      config,
      requestPayload: { message: 'test' },
      plan: { input: 'test', tool: 'readonly' },
    })
    const restored = restoreP7Snapshot(repo.get(task.taskId)!.input.config.value)
    expect(restored).toEqual(original)
    expect(
      repo.accept({ ...task.input, requestKey: 'r1', config: { ...config, model: 'changed' } })
        .taskId,
    ).toBe(task.taskId)
    expect(repo.get(task.taskId)!.input.config.model).toBe(original.model)
    expect(() =>
      repo.accept({
        ...task.input,
        requestKey: 'r2',
        runId: task.runId,
        config: { ...config, model: 'changed' },
      }),
    ).toThrow('快照不可切换')
  } finally {
    db.close()
  }
})
