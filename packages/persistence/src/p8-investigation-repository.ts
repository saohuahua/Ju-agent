import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { P6Task } from '../../contracts/src/p6-durable.js'
import type {
  P8BusinessReference,
  P8BranchResult,
  P8Conclusion,
  P8Input,
  P8Memory,
  P8Role,
} from '../../contracts/src/p8-investigation.js'
import { p8FactsFromEvidence } from '../../contracts/src/p8-investigation.js'
import type { SqliteDatabase } from './db.js'
import { P6TaskRepository } from './p6-task-repository.js'

interface Link {
  role: P8Role
  taskId: string
}
const terminal = (task: P6Task) => !['queued', 'running'].includes(task.status)

const requestKey = (input: P8Input) =>
  JSON.stringify(['p8-parent-v1', input.experimentId, input.caseId, input.repeat, input.mode])

/** 保留业务原状态 资金未终结或来源冲突时不能归入已完成动作 */
function uncertain(reference: P8BusinessReference): boolean {
  const execution = reference.execution
  return (
    ['executing', 'unknown', 'sending', 'needs_confirmation', 'processing'].includes(
      reference.status,
    ) ||
    Boolean(
      execution &&
      (!execution.bindingValid ||
        ['prepared', 'sending', 'unknown'].includes(execution.effectStatus ?? '') ||
        ['sending', 'unknown'].includes(execution.ownershipState ?? '') ||
        execution.taskStatus === 'needs_confirmation'),
    )
  )
}

/** 仅维护父子关联 原任务表继续拥有状态租约和检查点 */
export class P8InvestigationRepository {
  readonly tasks: P6TaskRepository
  constructor(readonly db: SqliteDatabase) {
    this.tasks = new P6TaskRepository(db)
    db.exec(`
      CREATE TABLE IF NOT EXISTS p8_investigations (
        parent_task_id TEXT PRIMARY KEY REFERENCES p6_tasks(task_id),
        input_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS p8_branches (
        parent_task_id TEXT NOT NULL REFERENCES p8_investigations(parent_task_id),
        role TEXT NOT NULL CHECK(role IN ('facts','policy')),
        task_id TEXT NOT NULL UNIQUE REFERENCES p6_tasks(task_id),
        PRIMARY KEY(parent_task_id, role)
      );
    `)
  }

  /** 同参重放读取原冻结任务 不因源事实后续变化丢失已受理结果 */
  replay(input: P8Input): P6Task | undefined {
    const existing = this.tasks.findRequest(input.customerId, requestKey(input))
    if (!existing) return undefined
    const prior = this.input(existing.taskId)
    if (!isDeepStrictEqual({ ...prior, acceptedAt: 0 }, { ...input, acceptedAt: 0 }))
      throw new Error('P8 受理身份内容冲突')
    return existing
  }

  accept(input: P8Input): P6Task {
    const config = {
      snapshotId: input.snapshot.version,
      provider: input.snapshot.provider,
      model: input.snapshot.model,
      promptVersion: input.snapshot.promptVersion,
      value: structuredClone(input.snapshot),
    }
    return this.db
      .transaction(() => {
        const existing = this.replay(input)
        if (existing) return existing
        const parent = this.tasks.accept({
          requestKey: requestKey(input),
          customerId: input.customerId,
          kind: 'start',
          source: 'sim',
          config,
          plan: { tool: 'p8-parent', input: input.orderNo },
        })
        this.db
          .prepare('INSERT INTO p8_investigations VALUES (?,?)')
          .run(parent.taskId, JSON.stringify(input))
        for (const role of ['facts', 'policy'] as const) {
          const child = this.tasks.accept({
            requestKey: JSON.stringify(['p8-child-v1', parent.taskId, role]),
            customerId: input.customerId,
            kind: 'start',
            source: 'sim',
            config,
            plan: { tool: `p8-${role}`, input: input.orderNo },
          })
          this.db
            .prepare('INSERT INTO p8_branches VALUES (?,?,?)')
            .run(parent.taskId, role, child.taskId)
          this.db
            .prepare('INSERT INTO p6_events(task_id,event_key,payload_json) VALUES (?,?,?)')
            .run(child.taskId, `p8-branch:${parent.taskId}`, '{}')
        }
        return parent
      })
      .immediate()
  }

  input(parentId: string): P8Input {
    const row = this.db
      .prepare('SELECT input_json AS value FROM p8_investigations WHERE parent_task_id = ?')
      .get(parentId) as { value: string } | undefined
    if (!row) throw new Error('未知 P8 父任务')
    return JSON.parse(row.value) as P8Input
  }

  children(parentId: string): Link[] {
    return this.db
      .prepare(
        'SELECT role, task_id AS taskId FROM p8_branches WHERE parent_task_id = ? ORDER BY role',
      )
      .all(parentId) as Link[]
  }

  parent(childId: string): P6Task {
    const row = this.db
      .prepare('SELECT parent_task_id AS id FROM p8_branches WHERE task_id = ?')
      .get(childId) as { id: string } | undefined
    if (!row) throw new Error('未知 P8 分支')
    return this.tasks.get(row.id)!
  }

  /** 分支原文在模型传输前确认 所有引用只能指向该运行的原文 */
  evidence(task: P6Task): P8Input {
    return this.tasks.fenced(task, () => {
      const parent = this.parent(task.taskId)
      if (terminal(parent) || parent.cancelRequested) throw new Error('P8 父任务已停止')
      const input = this.input(parent.taskId)
      if (task.customerId !== input.customerId || task.input.plan.input !== input.orderNo)
        throw new Error('P8 分支归属冲突')
      const role = this.children(parent.taskId).find((link) => link.taskId === task.taskId)!.role
      const evidence = input.evidence.filter((item) =>
        role === 'facts' ? item.kind !== 'policy' : item.kind === 'policy',
      )
      this.tasks.checkpoint(task, 'p8-evidence', evidence)
      return input
    })
  }

  /** 确认结果和通知父任务共用围栏事务 重复完成只接受完全相同的结果 */
  confirm(task: P6Task, result: P8BranchResult): boolean {
    return this.db
      .transaction(() => {
        const prior = this.tasks.step(task.taskId, 'p8-result')
        if (prior !== undefined) {
          if (JSON.stringify(prior) !== JSON.stringify(result)) throw new Error('P8 重复结果冲突')
          return false
        }
        this.tasks.assertOwned(task)
        const parent = this.parent(task.taskId)
        if (terminal(parent) || parent.cancelRequested) return false
        const input = this.input(parent.taskId)
        const role = this.children(parent.taskId).find((link) => link.taskId === task.taskId)!.role
        if (
          result.parentRunId !== parent.runId ||
          result.taskId !== task.taskId ||
          result.runId !== task.runId ||
          result.customerId !== input.customerId ||
          result.orderNo !== input.orderNo ||
          result.role !== role ||
          result.configVersion !== input.snapshot.version ||
          result.knowledgeVersion !== input.knowledgeVersion
        )
          throw new Error('P8 结果身份冲突')
        const allowed = new Set(
          input.evidence
            .filter((item) => (role === 'facts' ? item.kind !== 'policy' : item.kind === 'policy'))
            .map((item) => item.ref),
        )
        if (
          result.citations.some((ref) => !allowed.has(ref)) ||
          result.facts.some((fact) => !result.citations.includes(fact.ref))
        )
          throw new Error('P8 引用越界')
        if (result.status !== 'confirmed' && (result.facts.length || result.citations.length))
          throw new Error('P8 未确认调查不能声明成功事实')
        const evidence = this.tasks.step(task.taskId, 'p8-evidence') as
          P8Input['evidence'] | undefined
        if (
          !evidence ||
          (result.status === 'confirmed' &&
            (JSON.stringify(result.facts) !== JSON.stringify(p8FactsFromEvidence(evidence)) ||
              JSON.stringify(result.citations) !==
                JSON.stringify(evidence.map((item) => item.ref))))
        )
          throw new Error('P8 结果与已确认原文冲突')
        this.tasks.checkpoint(task, 'p8-result', result)
        this.tasks.finish(
          task,
          result.status === 'confirmed' ? 'completed' : 'call_failed',
          result.error,
        )
        this.notify(parent.taskId)
        return true
      })
      .immediate()
  }

  /** 只投递原事件 不维护另一套可运行队列 */
  notify(parentId: string): void {
    this.db
      .transaction(() => {
        if (!this.children(parentId).every((link) => terminal(this.tasks.get(link.taskId)!))) return
        this.db
          .prepare(
            "INSERT OR IGNORE INTO p6_events(task_id,event_key,payload_json) VALUES (?,?,'{}')",
          )
          .run(parentId, `p8-ready:${parentId}`)
      })
      .immediate()
  }

  cancel(parentId: string, customerId: string): boolean {
    return this.db
      .transaction(() => {
        if (!this.tasks.cancel(parentId, customerId)) return false
        for (const link of this.children(parentId)) this.tasks.cancel(link.taskId, customerId)
        return true
      })
      .immediate()
  }

  memory(parentId: string): P8Memory {
    const input = this.input(parentId)
    const parent = this.tasks.get(parentId)!
    const links = this.children(parentId)
    const results = links.map((link) => this.result(link.taskId))
    const unresolved = results.flatMap(
      (result, i) => result?.unresolved ?? [`${links[i]!.role} 调查尚未确认`],
    )
    return {
      parentRunId: parent.runId,
      customerId: input.customerId,
      orderNo: input.orderNo,
      userStatements: input.userStatements,
      evidenceRefs: input.evidence.map((item) => item.ref),
      confirmedFacts: results.flatMap((result) =>
        result?.status === 'confirmed' ? result.facts : [],
      ),
      unresolved,
      waitingReasons: [
        ...links
          .filter((link) => !terminal(this.tasks.get(link.taskId)!))
          .map((link) => `等待 ${link.role}`),
        ...results.flatMap((result) => (result?.error ? [result.error] : [])),
      ],
      branches: links.map((link) => ({ ...link, status: this.tasks.get(link.taskId)!.status })),
      businessReferences: input.businessReferences,
      completedActions: input.businessReferences.filter(
        (ref) => ['succeeded', 'completed', 'refunded'].includes(ref.status) && !uncertain(ref),
      ),
      unknownActions: input.businessReferences.filter(uncertain),
    }
  }

  /** 无确认结果的取消或执行失败从原任务终态投影 不伪造执行时间或事实 */
  result(taskId: string): P8BranchResult | undefined {
    const confirmed = this.tasks.step(taskId, 'p8-result') as P8BranchResult | undefined
    if (confirmed) return confirmed
    const task = this.tasks.get(taskId)!
    if (!terminal(task)) return undefined
    const parent = this.parent(taskId)
    const input = this.input(parent.taskId)
    const role = this.children(parent.taskId).find((link) => link.taskId === taskId)!.role
    return {
      parentRunId: parent.runId,
      taskId,
      runId: task.runId,
      customerId: task.customerId,
      orderNo: input.orderNo,
      role,
      status: task.status === 'cancelled' ? 'cancelled' : 'failed',
      facts: [],
      citations: [],
      unresolved: [`${role} 调查未确认`],
      error: task.error ?? '调查未确认',
      configVersion: input.snapshot.version,
      knowledgeVersion: input.knowledgeVersion,
      startedAt: null,
      finishedAt: null,
    }
  }

  conclude(task: P6Task, result: P8Conclusion): void {
    this.tasks.fenced(task, () => {
      if (this.tasks.assertOwned(task).cancelRequested) throw new Error('P8 父任务取消')
      if (!this.children(task.taskId).every((link) => terminal(this.tasks.get(link.taskId)!)))
        throw new Error('P8 分支尚未结束')
      this.tasks.checkpoint(task, 'p8-conclusion', result)
      this.tasks.finish(task, 'completed')
    })
  }
}

/** 原文内容哈希参与引用 防止摘要替代证据 */
export function p8EvidenceHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
