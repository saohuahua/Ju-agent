import type { SqliteDatabase } from './db.js'

/** 增量迁移只保存执行证据 历史非成功状态一律冻结 不推测没有支付 */
export function migrateExecutionOwnership(db: SqliteDatabase): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS execution_ownership (
        business_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL CHECK(owner IN ('legacy','p6','unassigned')),
        holder TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('ready','sending','unknown','succeeded','rejected')),
        token TEXT,
        result_json TEXT,
        CHECK(state != 'ready' OR owner != 'unassigned'),
        CHECK(state != 'sending' OR token IS NOT NULL)
      );
      INSERT OR IGNORE INTO execution_ownership
      SELECT key, 'unassigned', '', 'succeeded', NULL, result_json
      FROM idempotency_records
      WHERE key LIKE 'refund:%' OR key LIKE 'compensation:%' OR key LIKE 'price_protection:%';
      INSERT OR IGNORE INTO execution_ownership
      SELECT 'refund:' || return_no, 'unassigned', '',
        CASE WHEN status = 'succeeded' THEN 'succeeded' ELSE 'unknown' END, NULL, NULL
      FROM refunds;
      INSERT OR IGNORE INTO execution_ownership
      SELECT 'compensation:' || compensation_no, 'unassigned', '',
        CASE WHEN status = 'succeeded' THEN 'succeeded' ELSE 'unknown' END, NULL, NULL
      FROM compensations;
      INSERT OR IGNORE INTO execution_ownership
      SELECT 'price_protection:' || protection_no, 'unassigned', '',
        CASE WHEN status = 'succeeded' THEN 'succeeded' ELSE 'unknown' END, NULL, NULL
      FROM price_protections;
      INSERT OR IGNORE INTO execution_ownership
      SELECT business_key, 'unassigned', '',
        CASE WHEN status = 'succeeded' THEN 'succeeded' ELSE 'unknown' END, NULL, result_json
      FROM p6_effects;
    `)
  }).immediate()
}
