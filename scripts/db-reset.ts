/**
 * 重置本地数据库并载入演示夹具
 *
 * 用法 pnpm db:reset
 * 开发库是一次性资源 先删除数据库文件再重建 保证表结构取到最新 schema
 * （SQLite CREATE IF NOT EXISTS 不会给旧表补列 生产路径走 infra DDL 迁移）
 */

import { existsSync, rmSync } from 'node:fs'
import { openDatabase, loadFixture } from '@aftersales/persistence'

const dbPath = process.env.DB_PATH ?? './data/app.db'
if (existsSync(dbPath)) {
  rmSync(dbPath)
  // WAL 模式残留文件一并清理 避免旧页混入新库
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
}
const db = openDatabase(dbPath)
loadFixture(db, [])
console.log(`数据库已重置 ${dbPath}`)
console.log('演示客户令牌 cust-token-1001 cust-token-1002 cust-token-1003')
console.log('操作员令牌 operator-token 主管令牌 supervisor-token')
