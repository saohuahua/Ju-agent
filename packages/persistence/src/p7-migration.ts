import type { SqliteDatabase } from './db.js'

/** 独立迁移只增加模型计费表 不触碰业务支付和任务状态 */
export function migrateP7(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS p7_budgets (
      scope TEXT PRIMARY KEY,
      limit_micro INTEGER NOT NULL CHECK (limit_micro = 100000000),
      blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
      concurrency_limit INTEGER NOT NULL CHECK (concurrency_limit BETWEEN 1 AND 32)
    );
    CREATE TABLE IF NOT EXISTS p7_run_snapshots (
      scope TEXT NOT NULL,
      run_id TEXT NOT NULL,
      version TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      PRIMARY KEY (scope, run_id)
    );
    CREATE TABLE IF NOT EXISTS p7_calls (
      call_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL REFERENCES p7_budgets(scope),
      operation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      snapshot_version TEXT NOT NULL,
      price_version TEXT NOT NULL,
      price_json TEXT NOT NULL,
      currency TEXT NOT NULL CHECK (currency = 'CNY'),
      unit TEXT NOT NULL CHECK (unit = 'micro_yuan'),
      reserved INTEGER NOT NULL CHECK (reserved >= 0),
      actual INTEGER,
      status TEXT NOT NULL CHECK (status IN ('held', 'unknown', 'settled')),
      outcome TEXT,
      usage_json TEXT,
      created_at TEXT NOT NULL,
      settled_at TEXT,
      UNIQUE (scope, operation_id, attempt)
    );
    CREATE INDEX IF NOT EXISTS p7_calls_scope ON p7_calls(scope, status);
    CREATE TRIGGER IF NOT EXISTS p7_snapshot_immutable BEFORE UPDATE ON p7_run_snapshots
      BEGIN SELECT RAISE(ABORT, 'immutable snapshot'); END;
  `)
}
