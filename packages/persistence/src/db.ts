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

/** 建表迁移 幂等可重复执行 */
export function migrate(db: SqliteDatabase): void {
  db.exec(SCHEMA_SQL)
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
    'audit_logs',
    'tool_executions',
    'agent_events',
    'agent_runs',
    'checkpoints',
    'idempotency_records',
    'leases',
    'counters',
    'refunds',
    'approval_requests',
    'return_requests',
    'shipments',
    'orders',
    'customers',
    'policies',
  ]
  db.exec('BEGIN')
  try {
    for (const table of tables) {
      db.exec(`DELETE FROM ${table}`)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
