/**
 * 基础设施仓储 SQLite 实现
 *
 * 事件序号在单条语句内分配 依赖 UNIQUE 约束兜底并发
 * 租约用条件更新抢占 过期即可被他人接管
 */

import type { EventType, ToolErrorShape } from '@aftersales/contracts'
import type { AgentRunRecord, AuditLog, Checkpoint, ToolExecutionRecord } from '@aftersales/domain'
import type {
  AgentRunRepository,
  AnalyticsReadModel,
  AuditRepository,
  BusinessNoGenerator,
  CheckpointRepository,
  EventRepository,
  IdempotencyRepository,
  LeaseRepository,
  RatingRepository,
  RunRating,
  RunSource,
  ToolExecutionRepository,
} from '@aftersales/domain'
import type { SqliteDatabase } from './db.js'

export class SqliteAuditRepository implements AuditRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async append(entry: Omit<AuditLog, 'id'>): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO audit_logs
         (occurred_at, actor_role, actor_id, action, resource_type, resource_id, detail_json, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.occurredAt,
        entry.actorRole,
        entry.actorId,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        JSON.stringify(entry.detail),
        entry.runId,
      )
  }

  async listByRunId(runId: string): Promise<AuditLog[]> {
    const rows = this.db
      .prepare('SELECT * FROM audit_logs WHERE run_id = ? ORDER BY id')
      .all(runId) as Array<Record<string, unknown>>
    return rows.map((row) => this.mapRow(row))
  }

  async listByResource(resourceType: string, resourceId: string): Promise<AuditLog[]> {
    const rows = this.db
      .prepare('SELECT * FROM audit_logs WHERE resource_type = ? AND resource_id = ? ORDER BY id')
      .all(resourceType, resourceId) as Array<Record<string, unknown>>
    return rows.map((row) => this.mapRow(row))
  }

  private mapRow(row: Record<string, unknown>): AuditLog {
    return {
      id: row.id as number,
      occurredAt: row.occurred_at as string,
      actorRole: row.actor_role as string,
      actorId: row.actor_id as string,
      action: row.action as string,
      resourceType: row.resource_type as string,
      resourceId: row.resource_id as string,
      detail: JSON.parse(row.detail_json as string) as Record<string, unknown>,
      runId: (row.run_id as string | null) ?? null,
    }
  }
}

export class SqliteEventRepository implements EventRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async append(runId: string, type: EventType, payload: unknown): Promise<number> {
    const now = new Date().toISOString()
    // 同步驱动下取号与插入之间不会让出事件循环 UNIQUE 约束兜底极端情况
    const row = this.db
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM agent_events WHERE run_id = ?')
      .get(runId) as { max_seq: number }
    const sequence = row.max_seq + 1
    this.db
      .prepare(
        'INSERT INTO agent_events (run_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(runId, sequence, type, JSON.stringify(payload), now)
    return sequence
  }

  async listByRun(runId: string, fromSequence = 1) {
    const rows = this.db
      .prepare('SELECT * FROM agent_events WHERE run_id = ? AND sequence >= ? ORDER BY sequence')
      .all(runId, fromSequence) as Array<{
      run_id: string
      sequence: number
      type: string
      payload_json: string
      created_at: string
    }>
    return rows.map((row) => ({
      runId: row.run_id,
      sequence: row.sequence,
      type: row.type as EventType,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at,
    }))
  }
}

export class SqliteToolExecutionRepository implements ToolExecutionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async create(record: Omit<ToolExecutionRecord, 'id'>): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tool_executions
         (run_id, tool_name, args_json, status, error_code, attempt, latency_ms, result_summary_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.runId,
        record.toolName,
        JSON.stringify(record.args),
        record.status,
        record.errorCode,
        record.attempt,
        record.latencyMs,
        record.resultSummary ? JSON.stringify(record.resultSummary) : null,
        record.createdAt,
      )
  }

  async listByRunId(runId: string): Promise<ToolExecutionRecord[]> {
    return this.list('run_id = ?', runId)
  }

  async listAll(): Promise<ToolExecutionRecord[]> {
    return this.list('1 = 1')
  }

  private list(where: string, arg?: string): ToolExecutionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM tool_executions WHERE ${where} ORDER BY id`)
      .all(...(arg ? [arg] : [])) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: row.id as number,
      runId: (row.run_id as string | null) ?? null,
      toolName: row.tool_name as string,
      args: JSON.parse(row.args_json as string) as Record<string, unknown>,
      status: row.status as 'succeeded' | 'failed',
      errorCode: (row.error_code as string | null) ?? null,
      attempt: row.attempt as number,
      latencyMs: row.latency_ms as number,
      resultSummary: row.result_summary_json
        ? (JSON.parse(row.result_summary_json as string) as Record<string, unknown>)
        : null,
      createdAt: row.created_at as string,
    }))
  }
}

export class SqliteCheckpointRepository implements CheckpointRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async save(runId: string, stepId: string, state: Record<string, unknown>): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO checkpoints (run_id, step_id, state_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(runId, stepId, JSON.stringify(state), new Date().toISOString())
  }

  async latest(runId: string): Promise<Checkpoint | null> {
    const row = this.db
      .prepare('SELECT * FROM checkpoints WHERE run_id = ? ORDER BY id DESC LIMIT 1')
      .get(runId) as
      | { id: number; run_id: string; step_id: string; state_json: string; created_at: string }
      | undefined
    if (!row) return null
    return {
      id: row.id,
      runId: row.run_id,
      stepId: row.step_id,
      state: JSON.parse(row.state_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }
  }

  async listByRunId(runId: string): Promise<Checkpoint[]> {
    const rows = this.db
      .prepare('SELECT * FROM checkpoints WHERE run_id = ? ORDER BY id')
      .all(runId) as Array<{
      id: number
      run_id: string
      step_id: string
      state_json: string
      created_at: string
    }>
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      stepId: row.step_id,
      state: JSON.parse(row.state_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }))
  }
}

export class SqliteIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async find(key: string): Promise<{ key: string; result: Record<string, unknown> } | null> {
    const row = this.db.prepare('SELECT * FROM idempotency_records WHERE key = ?').get(key) as
      { key: string; result_json: string } | undefined
    if (!row) return null
    return { key: row.key, result: JSON.parse(row.result_json) as Record<string, unknown> }
  }

  async record(key: string, result: Record<string, unknown>): Promise<void> {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO idempotency_records (key, result_json, created_at) VALUES (?, ?, ?)',
      )
      .run(key, JSON.stringify(result), new Date().toISOString())
  }
}

export class SqliteAgentRunRepository implements AgentRunRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private mapRow(row: Record<string, unknown>): AgentRunRecord {
    return {
      runId: row.run_id as string,
      customerId: row.customer_id as string,
      status: row.status as AgentRunRecord['status'],
      intent: (row.intent as string | null) ?? null,
      promptVersion: row.prompt_version as string,
      model: row.model as string,
      error: (row.error as string | null) ?? null,
      faultPlan: JSON.parse((row.fault_plan_json as string) ?? '[]') as unknown[],
      source: ((row.source as string) ?? 'customer') as AgentRunRecord['source'],
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }
  }

  async create(record: AgentRunRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO agent_runs
         (run_id, customer_id, status, intent, prompt_version, model, error, fault_plan_json, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.runId,
        record.customerId,
        record.status,
        record.intent,
        record.promptVersion,
        record.model,
        record.error,
        JSON.stringify(record.faultPlan),
        record.source,
        record.createdAt,
        record.updatedAt,
      )
  }

  async findById(runId: string): Promise<AgentRunRecord | null> {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE run_id = ?').get(runId)
    return row ? this.mapRow(row as Record<string, unknown>) : null
  }

  async update(record: AgentRunRecord): Promise<void> {
    this.db
      .prepare(
        `UPDATE agent_runs
         SET status = ?, intent = ?, error = ?, updated_at = ?
         WHERE run_id = ?`,
      )
      .run(record.status, record.intent, record.error, record.updatedAt, record.runId)
  }

  async list(options?: {
    status?: string
    customerId?: string
    limit?: number
  }): Promise<AgentRunRecord[]> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (options?.status) {
      conditions.push('status = ?')
      params.push(options.status)
    }
    if (options?.customerId) {
      conditions.push('customer_id = ?')
      params.push(options.customerId)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM agent_runs ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...(params as never[]), options?.limit ?? 50)
    return rows.map((row) => this.mapRow(row as Record<string, unknown>))
  }
}

export class SqliteLeaseRepository implements LeaseRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async acquire(
    holder: string,
    resourceType: string,
    resourceId: string,
    ttlMs: number,
  ): Promise<boolean> {
    const resourceKey = `${resourceType}:${resourceId}`
    const now = Date.now()
    // 尝试插入 新资源直接获得租约
    const inserted = this.db
      .prepare('INSERT OR IGNORE INTO leases (resource_key, holder, expires_at) VALUES (?, ?, ?)')
      .run(resourceKey, holder, now + ttlMs)
    if (inserted.changes > 0) return true
    // 已有租约 过期或本就是自己 则接管
    const taken = this.db
      .prepare(
        'UPDATE leases SET holder = ?, expires_at = ? WHERE resource_key = ? AND (expires_at <= ? OR holder = ?)',
      )
      .run(holder, now + ttlMs, resourceKey, now, holder)
    return taken.changes > 0
  }

  async release(holder: string, resourceType: string, resourceId: string): Promise<void> {
    this.db
      .prepare('DELETE FROM leases WHERE resource_key = ? AND holder = ?')
      .run(`${resourceType}:${resourceId}`, holder)
  }
}

/** SQLite 单号生成器 计数器行级原子自增 */
export class SqliteBusinessNoGenerator implements BusinessNoGenerator {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly year: number = new Date().getUTCFullYear(),
  ) {}

  nextNo(prefix: string): string {
    const key = `${prefix}-${this.year}`
    this.db
      .prepare('INSERT INTO counters (key, value) VALUES (?, 0) ON CONFLICT(key) DO NOTHING')
      .run(key)
    const row = this.db
      .prepare('UPDATE counters SET value = value + 1 WHERE key = ? RETURNING value')
      .get(key) as { value: number }
    return `${prefix}-${this.year}-${String(row.value).padStart(4, '0')}`
  }
}

/** 评测报告持久化 供看板查询 */
export function saveEvalReport(
  db: SqliteDatabase,
  report: {
    reportId: string
    startedAt: string
    model: string
    promptVersion: string
    total: number
    passed: number
    failed: number
    gatePassed: boolean
    report: unknown
  },
): void {
  db.prepare(
    `INSERT INTO eval_reports
     (report_id, started_at, model, prompt_version, total, passed, failed, gate_passed, report_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    report.reportId,
    report.startedAt,
    report.model,
    report.promptVersion,
    report.total,
    report.passed,
    report.failed,
    report.gatePassed ? 1 : 0,
    JSON.stringify(report.report),
  )
}

export function listEvalReports(db: SqliteDatabase, limit = 20): Array<Record<string, unknown>> {
  const rows = db
    .prepare('SELECT * FROM eval_reports ORDER BY started_at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>
  return rows.map((row) => {
    const report = JSON.parse(row.report_json as string) as Record<string, unknown>
    return {
      reportId: row.report_id,
      startedAt: row.started_at,
      model: row.model,
      promptVersion: row.prompt_version,
      level: report.level,
      userModel: report.userModel,
      judgeModel: report.judgeModel,
      total: row.total,
      passed: row.passed,
      failed: row.failed,
      gatePassed: row.gate_passed === 1,
      report,
    }
  })
}

/** 供校验器使用的原始行查询 按表白名单访问 */
const QUERYABLE_TABLES = new Set([
  'orders',
  'shipments',
  'return_requests',
  'refunds',
  'compensations',
  'price_protections',
  'policy_articles',
  'approval_requests',
  'audit_logs',
  'tool_executions',
  'agent_runs',
  'agent_events',
  'ratings',
])

export function queryTable(
  db: SqliteDatabase,
  table: string,
  where?: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (!QUERYABLE_TABLES.has(table)) {
    throw new Error(`评测断言不允许访问表 ${table}`)
  }
  let sql = `SELECT * FROM ${table}`
  const params: unknown[] = []
  if (where && Object.keys(where).length > 0) {
    const conditions = Object.entries(where).map(([column, value]) => {
      params.push(value)
      return `${column} = ?`
    })
    sql += ` WHERE ${conditions.join(' AND ')}`
  }
  return db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>
}

/** 错误形状解码辅助 从工具执行记录还原错误码 */
export function decodeErrorShape(json: string): ToolErrorShape | null {
  try {
    return JSON.parse(json) as ToolErrorShape
  } catch {
    return null
  }
}

/** 满意度评分仓储 一 run 一评 主键即 run_id */
export class SqliteRatingRepository implements RatingRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async create(record: RunRating): Promise<void> {
    this.db
      .prepare('INSERT INTO ratings (run_id, score, comment, submitted_at) VALUES (?, ?, ?, ?)')
      .run(record.runId, record.score, record.comment, record.submittedAt)
  }

  async findByRunId(runId: string): Promise<RunRating | null> {
    const row = this.db.prepare('SELECT * FROM ratings WHERE run_id = ?').get(runId) as
      { run_id: string; score: number; comment: string | null; submitted_at: string } | undefined
    if (!row) return null
    return {
      runId: row.run_id,
      score: row.score,
      comment: row.comment,
      submittedAt: row.submitted_at,
    }
  }
}

/**
 * 运营分析读模型 SQL 实现
 *
 * 全部查询按 source 过滤 评测与模拟会话不进运营指标
 * 聚合口径与领域 AnalyticsService 声明一致
 */
export class SqliteAnalyticsReadModel implements AnalyticsReadModel {
  constructor(private readonly db: SqliteDatabase) {}

  async runStatusCounts(source: RunSource): Promise<Array<{ status: string; count: number }>> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM agent_runs WHERE source = ? GROUP BY status')
      .all(source) as Array<{ status: string; count: number }>
    return rows
  }

  async runsByDay(source: RunSource, days: number): Promise<Array<{ day: string; count: number }>> {
    const rows = this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
         FROM agent_runs
         WHERE source = ? AND created_at >= date('now', ?)
         GROUP BY day ORDER BY day`,
      )
      .all(source, `-${days} day`) as Array<{ day: string; count: number }>
    return rows
  }

  async avgTurns(source: RunSource): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT AVG(turn_count) AS avg_turns FROM (
           SELECT e.run_id, COUNT(*) AS turn_count
           FROM agent_events e
           JOIN agent_runs r ON r.run_id = e.run_id
           WHERE e.type = 'agent.turn' AND r.source = ?
           GROUP BY e.run_id
         )`,
      )
      .get(source) as { avg_turns: number | null }
    return row?.avg_turns ?? 0
  }

  async escalatedRunCount(source: RunSource): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT e.run_id) AS count
         FROM agent_events e
         JOIN agent_runs r ON r.run_id = e.run_id
         WHERE e.type = 'run.escalated' AND r.source = ?`,
      )
      .get(source) as { count: number }
    return row?.count ?? 0
  }

  async toolDistribution(
    source: RunSource,
  ): Promise<Array<{ toolName: string; total: number; failed: number }>> {
    const rows = this.db
      .prepare(
        `SELECT t.tool_name, COUNT(*) AS total,
                SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM tool_executions t
         LEFT JOIN agent_runs r ON r.run_id = t.run_id
         WHERE r.source = ?
         GROUP BY t.tool_name ORDER BY total DESC`,
      )
      .all(source) as Array<{ tool_name: string; total: number; failed: number }>
    return rows.map((row) => ({
      toolName: row.tool_name,
      total: row.total,
      failed: row.failed ?? 0,
    }))
  }

  async avgApprovalLatencyMs(): Promise<number | null> {
    const row = this.db
      .prepare(
        `SELECT AVG((julianday(decided_at) - julianday(created_at)) * 86400000) AS latency
         FROM approval_requests WHERE decided_at IS NOT NULL`,
      )
      .get() as { latency: number | null }
    return row?.latency ?? null
  }

  async decidedApprovalCount(): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM approval_requests WHERE decided_at IS NOT NULL')
      .get() as { count: number }
    return row?.count ?? 0
  }

  async ratingCounts(): Promise<Array<{ score: number; count: number }>> {
    const rows = this.db
      .prepare('SELECT score, COUNT(*) AS count FROM ratings GROUP BY score ORDER BY score')
      .all() as Array<{ score: number; count: number }>
    return rows
  }

  async ratingCount(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM ratings').get() as { count: number }
    return row?.count ?? 0
  }

  async ratingByFinalStatus(): Promise<Array<{ status: string; avgScore: number; count: number }>> {
    const rows = this.db
      .prepare(
        `SELECT r.status, AVG(g.score) AS avg_score, COUNT(*) AS count
         FROM ratings g
         JOIN agent_runs r ON r.run_id = g.run_id
         WHERE r.source = 'customer'
         GROUP BY r.status ORDER BY r.status`,
      )
      .all() as Array<{ status: string; avg_score: number; count: number }>
    return rows.map((row) => ({
      status: row.status,
      avgScore: row.avg_score ?? 0,
      count: row.count,
    }))
  }
}
