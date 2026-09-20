/**
 * 重置本地数据库并载入演示夹具
 *
 * 用法 pnpm db:reset
 */

import { openDatabase, loadFixture } from '@aftersales/persistence'

const dbPath = process.env.DB_PATH ?? './data/app.db'
const db = openDatabase(dbPath)
loadFixture(db, [])
console.log(`数据库已重置 ${dbPath}`)
console.log('演示客户令牌 cust-token-1001 cust-token-1002 cust-token-1003')
console.log('操作员令牌 operator-token 主管令牌 supervisor-token')
