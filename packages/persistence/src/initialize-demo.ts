import type { SqliteDatabase } from './db.js'
import { loadFixture } from './fixtures.js'

/** 只在所有应用表均为空时播种 任意残留事实都阻止自动覆盖 */
export function initializeDemo(db: SqliteDatabase): 'seeded' | 'existing' {
  return db
    .transaction(() => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
      for (const { name } of tables) {
        const quoted = name.replaceAll('"', '""')
        if (db.prepare(`SELECT 1 FROM "${quoted}" LIMIT 1`).get()) return 'existing'
      }
      loadFixture(db)
      return 'seeded'
    })
    .immediate()
}
