/**
 * API 服务入口
 *
 * 环境变量
 *   DB_PATH           SQLite 文件路径 缺省 data/app.db
 *   API_PORT          监听端口 缺省 8787
 *   ANTHROPIC_API_KEY 可选 配置后启用真实模型对话
 *   OPERATOR_TOKEN    操作员令牌
 *   SUPERVISOR_TOKEN  主管令牌
 *
 * 未配置模型密钥时服务照常启动 审批 运营 评测看板均可用
 */

import { serve } from '@hono/node-server'
import { AnthropicModel } from '@aftersales/agent'
import { ScriptedModel } from '@aftersales/agent'
import type { ChatModel } from '@aftersales/agent'
import { openDatabase, loadFixture } from '@aftersales/persistence'
import { composeSystem } from '@aftersales/runtime'
import { SystemClock } from '@aftersales/domain'
import { createApp } from './app.js'

function resolveModel(): { model: ChatModel; available: boolean; label: string } {
  if (process.env.ANTHROPIC_API_KEY) {
    const model = new AnthropicModel()
    return { model, available: true, label: model.info.model }
  }
  // 无密钥时用空脚本模型占位 创建运行的入口由 modelAvailable 闸门拦下
  return { model: new ScriptedModel([]), available: false, label: '未配置 使用脚本化占位' }
}

const dbPath = process.env.DB_PATH ?? './data/app.db'
const db = openDatabase(dbPath)

// 首次启动自动载入演示夹具 已有数据的库不重复覆盖
const hasOrders = db.prepare('SELECT COUNT(*) AS count FROM orders').get() as { count: number }
if (hasOrders.count === 0) {
  loadFixture(db, [])
  console.log('已载入演示数据 客户令牌 cust-token-1001 cust-token-1002 cust-token-1003')
}

const { model, available, label } = resolveModel()
const system = composeSystem({
  db,
  clock: new SystemClock(),
  model,
  withFixture: false,
})

const app = createApp({ system, modelAvailable: available })
const port = Number(process.env.API_PORT ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`售后 API 已启动 http://localhost:${info.port}`)
  console.log(`模型 ${label}`)
  console.log('健康检查 GET /api/health')
})
