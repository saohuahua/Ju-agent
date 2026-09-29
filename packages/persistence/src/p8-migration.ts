import type { SqliteDatabase } from './db.js'

export function migrateP8(db: SqliteDatabase): void {
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
