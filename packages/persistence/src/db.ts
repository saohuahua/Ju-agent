/**
 * 数据库连接与迁移
 *
 * SQLite 说明
 * 开发与评测环境使用单文件数据库 评测使用内存库每用例重建
 * 生产路径的 PostgreSQL DDL 见 infra postgres 目录
 * 仓储接口保证两者可替换 关键约束语义一致
 */

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { SCHEMA_SQL } from './schema.js'
import { migrateP6 } from './p6-migration.js'
import { migrateP7 } from './p7-migration.js'
import { migrateExecutionOwnership } from './execution-ownership-migration.js'

export type SqliteDatabase = Database.Database

/** 打开数据库文件 自动建目录与迁移 生产服务长期持有单个连接 */
export function openDatabase(dbPath: string): SqliteDatabase {
  const resolved = resolve(dbPath)
  if (resolved !== ':memory:') {
    mkdirSync(dirname(resolved), { recursive: true })
  }
  const db = new Database(resolved)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

/** 建表迁移 幂等可重复执行 老库补列 */
export function migrate(db: SqliteDatabase): void {
  db.exec(SCHEMA_SQL)
  // agent_runs.source 增量列 老库无此列时补齐 新库建表已含
  const runColumns = db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>
  if (!runColumns.some((column) => column.name === 'source')) {
    db.exec("ALTER TABLE agent_runs ADD COLUMN source TEXT NOT NULL DEFAULT 'customer'")
  }
  // 持久任务与预算只做增量迁移 不自动认领历史任务或释放未知费用
  migrateP6(db)
  migrateP7(db)
  migrateExecutionOwnership(db)
  // 评测归因附件独立于业务夹具和费用账本 保留历史实验关联
  db.exec(`CREATE TABLE IF NOT EXISTS eval_budget_evidence (
    report_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, evidence_json TEXT NOT NULL
  )`)
}

/** 评测与测试用 每次全新内存库 */
export function createMemoryDatabase(): SqliteDatabase {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

/** 清空业务数据 保留表结构 用于夹具重置 */
export function clearBusinessData(db: SqliteDatabase): void {
  const tables = [
    'p6_conversation_refunds',
    'execution_ownership',
    'p6_events',
    'p6_steps',
    'p6_effects',
    'p6_tasks',
    'p6_commands',
    // 业务夹具重置不清空费用账本 防止重置业务数据绕过累计预算
    'approval_execution_intents',
    // 先删除引用运行的内部备注以满足外键约束
    'internal_notes',
    'audit_logs',
    'tool_executions',
    'agent_events',
    'agent_runs',
    'ratings',
    'checkpoints',
    'idempotency_records',
    'leases',
    'counters',
    'refunds',
    'approval_requests',
    'return_requests',
    'compensations',
    'price_protections',
    'sku_prices',
    'policy_articles',
    'shipments',
    'orders',
    'customers',
    'policies',
  ]
  // 嵌套调用使用保存点 让首次播种与清理共享原子事务
  db.transaction(() => {
    for (const table of tables) {
      db.exec(`DELETE FROM ${table}`)
    }
  })()
}
