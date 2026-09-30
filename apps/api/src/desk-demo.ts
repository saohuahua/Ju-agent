import { serve } from '@hono/node-server'
import { ScriptedModel } from '@aftersales/agent'
import { FrozenClock, KeywordPolicyScorer } from '@aftersales/domain'
import { openDatabase, loadFixture } from '@aftersales/persistence'
import { composeSystem } from '@aftersales/runtime'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'

/**
 * 离线验收使用独立数据库与脚本模型且不读取任何模型凭据
 * 样例通过真实运行器和工具生成事件并标注为模拟会话
 * 重复启动保留已有会话与备注 避免覆盖用户演示记录
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const paginationFixture = process.argv.includes('--pagination')
const databasePath = paginationFixture ? 'data/desk-pagination-demo.db' : 'data/desk-demo.db'
const db = openDatabase(resolve(root, databasePath))
const count = db.prepare('SELECT COUNT(*) AS count FROM orders').get() as { count: number }

if (count.count === 0) loadFixture(db, [])

const model = new ScriptedModel([
  { kind: 'tool_call', tool: 'get_order', args: { orderNo: 'SO-2026-0003' }, reason: '核验订单' },
  {
    kind: 'tool_call',
    tool: 'search_policy',
    args: { query: '质量问题退货退款' },
    reason: '查找政策候选',
  },
  {
    kind: 'escalate',
    reason: '客户要求人工核验键盘故障与售后方案',
    escalationKind: 'customer_request',
  },
])
const system = composeSystem({
  db,
  clock: new FrozenClock('2026-09-20T12:00:00Z'),
  model,
  policyScorer: new KeywordPolicyScorer(),
  withFixture: false,
})
const existing = await system.runService.list({ limit: 1 })

if (existing.length === 0) {
  const run = await system.runService.start({
    customerId: 'C1001',
    model: 'scripted-v1',
    promptVersion: 'desk-demo-v1',
    source: 'sim',
  })

  await system.runner.start(
    run.runId,
    '订单 SO-2026-0003 的机械键盘有按键失灵 请人工核验退货方案',
    {
      actor: { role: 'customer', customerId: 'C1001' },
      runId: run.runId,
      faults: null,
    },
  )

  // 分页验收使用独立库 构造的会话明确标注为布局测试而非模型成功案例
  if (paginationFixture) {
    for (let index = 1; index <= 35; index += 1) {
      const item = await system.runService.start({
        customerId: 'C1001',
        model: 'ui-fixture',
        promptVersion: 'pagination-fixture',
        source: 'sim',
      })
      await system.runService.transition(item.runId, 'running')
      await system.runService.emit(item.runId, 'message.user', {
        text: `分页验收样例 ${index} 仅验证列表与状态展示`,
      })
      await system.runService.emit(item.runId, 'message.completed', {
        text: '这是构造的界面验收记录 不代表模型处理结果',
      })
      await system.runService.transition(item.runId, 'completed')
      await system.runService.emit(item.runId, 'run.completed', {
        summary: '界面验收夹具',
        escalated: false,
      })
    }
  }
}

// 仅开放本机演示端口 新模型任务保持禁用
serve(
  { fetch: createApp({ system, modelAvailable: false }).fetch, port: 8787, hostname: '127.0.0.1' },
  () => {
    console.log(`离线工作台 API http://127.0.0.1:8787 数据库 ${databasePath}`)
  },
)
