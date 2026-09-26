/**
 * API 服务入口
 *
 * 环境变量
 *   DB_PATH           SQLite 文件路径 缺省 data/app.db
 *   API_PORT          监听端口 缺省 8787
 *   P6_BUSINESS_MODE  simulation 显式启用持久离线会话
 *   OPERATOR_TOKEN    操作员令牌
 *   SUPERVISOR_TOKEN  主管令牌
 *
 * 真实模型入口保持关闭 不读取模型凭据或环境文件
 */

import { serve } from '@hono/node-server'
import { openDatabase, loadFixture, loadPolicyArticles } from '@aftersales/persistence'
import { composeSystem } from '@aftersales/runtime'
import { SystemClock } from '@aftersales/domain'
import { createApp } from './app.js'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveApiModelEntry } from './model-entry.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
// 模式拒绝先于数据库初始化 不因真实模式请求迁移或播种任何业务库
const {
  model,
  available,
  label,
  durableConversation: durableOptions,
} = resolveApiModelEntry(process.env.P6_BUSINESS_MODE)

// DB_PATH 相对路径锚定仓库根 与评测 CLI 落库位置一致 避免 cwd 差异写出两个库
const dbPath = resolve(repoRoot, process.env.DB_PATH ?? 'data/app.db')
const db = openDatabase(dbPath)

// 首次启动自动载入演示夹具 已有数据的库不重复覆盖
const hasOrders = db.prepare('SELECT COUNT(*) AS count FROM orders').get() as { count: number }
if (hasOrders.count === 0) {
  loadFixture(db, [])
  console.log('已载入演示数据 客户令牌 cust-token-1001 cust-token-1002 cust-token-1003')
}

// 政策语料为空时补种 老演示库升级到政策检索功能后仍可用
const hasArticles = db.prepare('SELECT COUNT(*) AS count FROM policy_articles').get() as {
  count: number
}
if (hasArticles.count === 0) {
  loadPolicyArticles(db)
  console.log('已补种政策条款语料')
}

const system = composeSystem({
  db,
  clock: new SystemClock(),
  model,
  withFixture: false,
  durableConversation: durableOptions,
  durableBusiness: durableOptions
    ? {
        snapshot: durableOptions.snapshot,
        paymentUrl: process.env.P6_PAYMENT_SIMULATOR_URL ?? 'http://127.0.0.1:8792',
      }
    : undefined,
})
system.conversations?.start()
system.durableBusiness?.start()

const app = createApp({ system, modelAvailable: available })
const port = Number(process.env.API_PORT ?? 8787)

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`售后 API 已启动 http://127.0.0.1:${info.port}`)
  console.log(`模型 ${label}`)
  console.log('健康检查 GET /api/health')
})

// 关闭监听后等待当前有界任务退出 不清理持久命令和资金意图
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.close(() => {
      void Promise.all([system.conversations?.stop(), system.durableBusiness?.stop()]).then(() => {
        db.close()
        process.exit(0)
      })
    })
  })
