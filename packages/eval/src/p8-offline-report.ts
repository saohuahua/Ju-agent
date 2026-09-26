import type { P8Conclusion } from '../../contracts/src/p8-investigation.js'
import type { P8Investigation } from '../../runtime/src/p8-investigation.js'

/** 报告只观察原任务检查点账本 不推断未知费用为零 */
export function p8Report(runtime: P8Investigation, parentId: string) {
  const input = runtime.repo.input(parentId)
  const parent = runtime.repo.tasks.get(parentId)!
  const tasks = [
    parent,
    ...runtime.repo.children(parentId).map((link) => runtime.repo.tasks.get(link.taskId)!),
  ]
  const taskIds = tasks.map((task) => task.taskId)
  const steps = runtime.db
    .prepare(
      'SELECT * FROM p6_steps WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY task_id, step',
    )
    .all(JSON.stringify(taskIds))
  const events = runtime.db
    .prepare(
      'SELECT * FROM p6_events WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY cursor',
    )
    .all(JSON.stringify(taskIds))
  const branches = runtime.repo.children(parentId).map((link) => runtime.repo.result(link.taskId))
  const calls = runtime.db
    .prepare(
      'SELECT * FROM p7_calls WHERE operation_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, call_id',
    )
    .all(
      JSON.stringify(taskIds.map((id) => JSON.stringify(['p8-call-v1', id, 'analysis']))),
    ) as Array<{
    purpose: string
    actual: number | null
    reserved: number
    status: string
    operation_id: string
  }>
  const conclusion = runtime.repo.tasks.step(parentId, 'p8-conclusion') as P8Conclusion | undefined
  const durations = branches.flatMap((result) =>
    result && result.finishedAt !== null && result.startedAt !== null
      ? [result.finishedAt - result.startedAt]
      : [],
  )
  const validCitations = branches.every(
    (result) =>
      result?.status === 'confirmed' &&
      result.citations.every((ref) => input.evidence.some((evidence) => evidence.ref === ref)),
  )
  return {
    schemaVersion: 1,
    mode: 'deterministic-offline',
    input,
    parent,
    tasks,
    steps,
    events,
    branches,
    conclusion,
    memory: runtime.repo.memory(parentId),
    calls,
    scopeTotals: runtime.ledger.totals(),
    metrics: {
      taskCompleted: parent.status === 'completed',
      investigationComplete: conclusion?.status === 'complete',
      factsAndCitationsValid: validCitations,
      unresolved: conclusion?.memory.unresolved ?? runtime.repo.memory(parentId).unresolved,
      calls: calls.length,
      logicalCalls: new Set(calls.map((call) => call.operation_id)).size,
      purposes: Object.fromEntries(
        ['main_agent', 'sub_agent'].map((purpose) => [
          purpose,
          calls.filter((call) => call.purpose === purpose).length,
        ]),
      ),
      settledMicroYuan: calls.reduce(
        (sum, call) => sum + (call.status === 'settled' ? call.actual! : 0),
        0,
      ),
      unknownReservedMicroYuan: calls.reduce(
        (sum, call) => sum + (call.status === 'unknown' ? call.reserved : 0),
        0,
      ),
      heldReservedMicroYuan: calls.reduce(
        (sum, call) => sum + (call.status === 'held' ? call.reserved : 0),
        0,
      ),
      endToEndMs: conclusion ? conclusion.finishedAt - input.acceptedAt : null,
      investigationCriticalPathMs:
        durations.length === 2
          ? input.mode === 'single'
            ? durations.reduce((sum, n) => sum + n, 0)
            : Math.max(...durations)
          : null,
      failedBranches: branches.filter((result) => result && result.status !== 'confirmed').length,
      cancelledTasks: tasks.filter((task) => task.status === 'cancelled').length,
      realProviderCost: 'not_measured',
    },
  }
}
