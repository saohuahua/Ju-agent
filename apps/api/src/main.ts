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
import { openDatabase, initializeDemo, startP6PaymentSimulator } from '@aftersales/persistence'
import type { Server } from 'node:http'
import type { Socket } from 'node:net'
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

console.log(`演示初始化 ${initializeDemo(db)}`)

// 组合部署复用原回环模拟器 渠道始终使用独立数据库
let channelDb: ReturnType<typeof openDatabase> | undefined
let channelServer: Server | undefined
let paymentUrl = process.env.P6_PAYMENT_SIMULATOR_URL ?? 'http://127.0.0.1:8792'
if (process.env.P6_EMBEDDED_SIMULATOR === '1') {
  if (!durableOptions) throw new Error('组合渠道要求显式 simulation 模式')
  const channelPath = resolve(repoRoot, process.env.P6_CHANNEL_DB_PATH ?? 'data/channel.db')
  if (channelPath === dbPath) throw new Error('渠道库与业务库必须独立')
  channelDb = openDatabase(channelPath)
  channelServer = await startP6PaymentSimulator(channelDb, 0)
  paymentUrl = `http://127.0.0.1:${(channelServer.address() as { port: number }).port}`
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
        paymentUrl,
      }
    : undefined,
})
system.conversations?.start()
system.durableBusiness?.start()

const shutdown = new AbortController()
const app = createApp({
  system,
  modelAvailable: available,
  shutdownSignal: shutdown.signal,
  readiness: async () => {
    if (!durableOptions) return false
    const response = await fetch(`${paymentUrl}/health`, {
      signal: AbortSignal.timeout(1500),
      redirect: 'error',
    })
    return (
      response.ok &&
      ['customers', 'orders', 'policies', 'policy_articles'].every((table) =>
        Boolean(db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()),
      )
    )
  },
})
const port = Number(process.env.API_PORT ?? 8787)

const server = serve(
  { fetch: app.fetch, port, hostname: process.env.API_HOST ?? '127.0.0.1' },
  (info) => {
    console.log(`售后 API 已启动 http://127.0.0.1:${info.port}`)
    console.log(`模型 ${label}`)
    console.log('健康检查 GET /api/health')
  },
)
const sockets = new Set<Socket>()
server.on('connection', (socket: Socket) => {
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
})

// 先断接入与长连接 再等待工作线程 最后关闭渠道及数据库
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    if (shutdown.signal.aborted) return
    shutdown.abort()
    const deadline = setTimeout(() => {
      console.error('退出超时 保留持久事实等待原恢复机制')
      process.exit(1)
    }, 15000)
    const closed = new Promise<void>((done) => server.close(() => done()))
    for (const socket of sockets) socket.destroy()
    void Promise.all([closed, system.conversations?.stop(), system.durableBusiness?.stop()])
      .then(async () => {
        if (channelServer) await new Promise<void>((done) => channelServer!.close(() => done()))
        channelDb?.close()
        db.close()
        clearTimeout(deadline)
        console.log('监听 SSE Worker 与数据库已关闭')
        process.exit(0)
      })
      .catch((error: unknown) => {
        console.error('关闭失败 保留持久事实', error)
        process.exit(1)
      })
  })
