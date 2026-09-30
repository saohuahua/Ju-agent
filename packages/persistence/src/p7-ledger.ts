import type { SqliteDatabase } from './db.js'
import {
  P7Error,
  P7Purpose,
  type P7CallIdentity,
  type P7Snapshot,
  type P7Usage,
} from '../../contracts/src/p7-model-gateway.js'
import { migrateP7 } from './p7-migration.js'

export interface P7LedgerRow {
  call_id: string
  reserved: number
  actual: number | null
  status: 'held' | 'unknown' | 'settled'
  outcome: string | null
  usage_json: string | null
}

/** 按会话导出追踪用的调用行 含时间与用途 */
export interface P7CallTrace {
  call_id: string
  run_id: string
  purpose: string
  attempt: number
  status: 'held' | 'unknown' | 'settled'
  outcome: string | null
  usage_json: string | null
  created_at: string
  settled_at: string | null
}

/** 账本所有写入使用立即事务 跨连接先占额度后允许外部调用 */
export class P7Ledger {
  constructor(private readonly db: SqliteDatabase) {
    migrateP7(db)
    db.pragma('busy_timeout = 5000')
  }

  reserve(identity: P7CallIdentity, snapshot: P7Snapshot, reserved: number): void {
    if (!Number.isSafeInteger(reserved) || reserved < 0 || !snapshot.price)
      throw new P7Error('CONFIG')
    if (
      !identity.callId ||
      !identity.operationId ||
      !identity.runId ||
      !Number.isInteger(identity.attempt) ||
      identity.attempt < 1 ||
      identity.attempt > snapshot.maxAttempts
    )
      throw new P7Error('CONFIG')
    P7Purpose.parse(identity.purpose)
    const scope = `${snapshot.mode}:${snapshot.budgetRef}`
    this.db
      .transaction(() => {
        this.db
          .prepare('INSERT OR IGNORE INTO p7_budgets VALUES (?, 100000000, 0, ?)')
          .run(scope, snapshot.maxConcurrency)
        const budget = this.db.prepare('SELECT * FROM p7_budgets WHERE scope = ?').get(scope) as {
          blocked: number
          concurrency_limit: number
        }
        // 并发上限只能收紧 不能通过更换模型快照扩大整个实验额度
        const concurrency = Math.min(budget.concurrency_limit, snapshot.maxConcurrency)
        this.db
          .prepare('UPDATE p7_budgets SET concurrency_limit = ? WHERE scope = ?')
          .run(concurrency, scope)
        const totals = this.totals(scope)
        if (budget.blocked || totals.committed + reserved > 100000000)
          throw new P7Error('BUDGET_EXCEEDED')
        if (totals.active >= concurrency) throw new P7Error('CONCURRENCY')
        const prior = this.db
          .prepare('SELECT version FROM p7_run_snapshots WHERE scope = ? AND run_id = ?')
          .get(scope, identity.runId) as { version: string } | undefined
        if (prior && prior.version !== snapshot.version) throw new P7Error('CONFIG')
        this.db
          .prepare('INSERT OR IGNORE INTO p7_run_snapshots VALUES (?, ?, ?, ?)')
          .run(scope, identity.runId, snapshot.version, JSON.stringify(snapshot))
        this.db
          .prepare(
            `INSERT INTO p7_calls (call_id, scope, operation_id, run_id, purpose, attempt, snapshot_version, price_version, price_json, currency, unit, reserved, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CNY', 'micro_yuan', ?, 'held', ?)`,
          )
          .run(
            identity.callId,
            scope,
            identity.operationId,
            identity.runId,
            identity.purpose,
            identity.attempt,
            snapshot.version,
            snapshot.price!.version,
            JSON.stringify(snapshot.price),
            reserved,
            new Date().toISOString(),
          )
      })
      .immediate()
  }

  /** 未知费用继续占满预留 进程退出遗留的 held 也不自动回收 */
  finish(callId: string, actual: number | null, usage: P7Usage | null, outcome: string): void {
    if (actual !== null && (!Number.isSafeInteger(actual) || actual < 0))
      throw new P7Error('CONFIG')
    this.db
      .transaction(() => {
        const row = this.db.prepare('SELECT * FROM p7_calls WHERE call_id = ?').get(callId) as
          (P7LedgerRow & { scope: string }) | undefined
        if (!row) throw new P7Error('CONFIG')
        if (row.status !== 'held') {
          if (
            row.actual === actual &&
            row.outcome === outcome &&
            row.usage_json === (usage ? JSON.stringify(usage) : null)
          )
            return
          throw new P7Error('CONFIG')
        }
        this.db
          .prepare(
            'UPDATE p7_calls SET actual = ?, status = ?, usage_json = ?, outcome = ?, settled_at = ? WHERE call_id = ? AND status = ?',
          )
          .run(
            actual,
            actual === null ? 'unknown' : 'settled',
            usage ? JSON.stringify(usage) : null,
            outcome,
            new Date().toISOString(),
            callId,
            'held',
          )
        // 上游违反声明上界时记录全部真实费用并熔断 后续调用不得掩盖超额
        if (actual !== null && actual > row.reserved)
          this.db.prepare('UPDATE p7_budgets SET blocked = 1 WHERE scope = ?').run(row.scope)
      })
      .immediate()
  }

  totals(scope = 'simulation:first-real-cny-100'): { committed: number; active: number } {
    // 超时取消和断连可能仍在远端运行 未知记录保留并发槽直到人工核验
    return this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status = 'settled' THEN actual ELSE reserved END), 0) AS committed,
      COALESCE(SUM(CASE WHEN status = 'held' OR (status = 'unknown' AND outcome IN ('TIMEOUT', 'CANCELLED', 'CONNECTION')) THEN 1 ELSE 0 END), 0) AS active FROM p7_calls WHERE scope = ?`,
      )
      .get(scope) as { committed: number; active: number }
  }

  rows(): P7LedgerRow[] {
    return this.db
      .prepare('SELECT * FROM p7_calls ORDER BY created_at, call_id')
      .all() as P7LedgerRow[]
  }

  /** 只读列出某会话的模型调用 供离线追踪导出 */
  listByRun(runId: string): P7CallTrace[] {
    return this.db
      .prepare(
        `SELECT call_id, run_id, purpose, attempt, status, outcome, usage_json, created_at, settled_at
         FROM p7_calls WHERE run_id = ? ORDER BY created_at, call_id`,
      )
      .all(runId) as P7CallTrace[]
  }
}
