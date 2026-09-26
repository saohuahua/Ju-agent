import { serve } from '@hono/node-server'
import { ScriptedModel } from '@aftersales/agent'
import { KeywordPolicyScorer, SystemClock } from '@aftersales/domain'
import { composeSystem } from '@aftersales/runtime'
import { createApp } from '../../src/app.js'
import { seedApprovalProgress } from './approval-progress-seed.js'

/**
 * 集成验收使用内存数据库和显式脚本模型 不读取凭据也不接触演示库
 * 评价写请求延迟返回 用于复现提交期间切换会话的竞态
 */
const clock = new SystemClock()
const system = composeSystem({
  clock,
  policyScorer: new KeywordPolicyScorer(),
  model: new ScriptedModel([
    {
      kind: 'final',
      answer: '验收脚本 已完成模拟退款处理',
      summary: '模拟退款核验',
      escalated: false,
    },
    { kind: 'clarify', question: '验收脚本 请补充订单编号', missingSlots: ['orderNo'] },
    { kind: 'final', answer: '验收脚本 已收到补充信息', summary: '补充流程核验', escalated: false },
  ]),
})

const ids: Record<string, string> = {}
for (const name of ['评价甲', '评价乙', '人工留言']) {
  const run = await system.runService.start({
    customerId: 'C1001',
    model: 'ui-fixture',
    promptVersion: 'acceptance',
    source: 'sim',
  })
  ids[name] = run.runId
  await system.runService.transition(run.runId, 'running')
  await system.runService.emit(run.runId, 'message.user', { text: `${name}界面验收记录` })
  if (name === '人工留言') {
    await system.runService.transition(run.runId, 'escalated')
    await system.handoverService.takeOver({ role: 'operator' }, run.runId)
  } else {
    await system.runService.transition(run.runId, 'completed')
    await system.runService.emit(run.runId, 'run.completed', {
      summary: '界面验收夹具',
      escalated: false,
    })
  }
}

// 待审批案例通过真实运行器产生断点 审批仍需通过正式事务校验
const seeder = composeSystem({
  db: system.db,
  clock,
  withFixture: false,
  policyScorer: new KeywordPolicyScorer(),
  model: new ScriptedModel([
    { kind: 'tool_call', tool: 'get_order', args: { orderNo: 'SO-2026-0001' }, reason: '验收查单' },
    {
      kind: 'action',
      intent: 'submit_refund_only',
      slots: { orderNo: 'SO-2026-0001', reason: 'unshipped_cancel' },
      reason: '验收审批链路',
    },
  ]),
})
const approvalRun = await seeder.runService.start({
  customerId: 'C1001',
  model: 'ui-fixture',
  promptVersion: 'acceptance',
  source: 'sim',
})
ids['审批'] = approvalRun.runId
await seeder.runner.start(approvalRun.runId, '验收脚本 订单 SO-2026-0001 未发货申请退款', {
  actor: { role: 'customer', customerId: 'C1001' },
  runId: approvalRun.runId,
  faults: null,
})

const app = createApp({ system, modelAvailable: true })
if (process.env.APPROVAL_PROGRESS_FIXTURE === '1') await seedApprovalProgress(system)
serve(
  {
    hostname: '127.0.0.1',
    port: 8787,
    fetch: async (request) => {
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/rating')) {
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
      return app.fetch(request)
    },
  },
  () => console.log(JSON.stringify({ mode: 'scripted-ui-acceptance', runs: ids })),
)
