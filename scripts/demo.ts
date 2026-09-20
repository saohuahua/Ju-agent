/**
 * 离线端到端演示
 *
 * 无需模型密钥 用脚本化模型驱动五个核心场景在终端完整走一遍
 * 覆盖 查单 退货 大额审批 中断恢复 重复提交拦截
 * 每个场景独立装配内存库 演示输出可重复
 */

import type { AgentOutput } from '@aftersales/contracts'
import { ScriptedModel } from '@aftersales/agent'
import { FrozenClock } from '@aftersales/domain'
import { composeSystem, BASELINE_FROZEN_TIME } from '@aftersales/runtime'
import { FaultController } from '@aftersales/tools'
import { PROMPT_VERSION } from '@aftersales/agent'

const C1001 = { role: 'customer' as const, customerId: 'C1001' }
const C1002 = { role: 'customer' as const, customerId: 'C1002' }
const supervisor = { role: 'supervisor' as const }
const operator = { role: 'operator' as const }

function compose(script: AgentOutput[]) {
  const system = composeSystem({
    clock: new FrozenClock(BASELINE_FROZEN_TIME),
    model: new ScriptedModel(script),
    timeoutOverrideMs: 300,
  })
  return system
}

async function newRun(
  system: ReturnType<typeof compose>,
  actor: { role: 'customer'; customerId: string },
  message: string,
  faults: FaultController | null,
) {
  const run = await system.runService.start({
    customerId: actor.customerId,
    promptVersion: PROMPT_VERSION,
    model: 'scripted-v1',
  })
  return { runId: run.runId, toolContext: { actor, runId: run.runId, faults } }
}

function line(title: string): void {
  console.log(`\n\x1b[36m${'─'.repeat(56)}\x1b[0m\n\x1b[1m${title}\x1b[0m`)
}

async function scenario1(): Promise<void> {
  line('场景一 查单与物流查询')
  const system = compose([
    { kind: 'tool_call', tool: 'get_order', args: { orderNo: 'SO-2026-0002' }, reason: '查订单' },
    {
      kind: 'tool_call',
      tool: 'get_shipment',
      args: { orderNo: 'SO-2026-0002' },
      reason: '查物流',
    },
    {
      kind: 'final',
      answer: '您的订单由顺丰承运 目前在上海浦东分拨中心 预计两天内送达',
      escalated: false,
      summary: '查单完成',
    },
  ])
  const { runId, toolContext } = await newRun(system, C1001, '订单 SO-2026-0002 到哪了', null)
  const outcome = await system.runner.start(runId, '订单 SO-2026-0002 到哪了', toolContext)
  const events = await system.eventRepo.listByRun(runId)
  console.log(`运行结果 ${outcome}  事件数 ${events.length}`)
  console.log(
    '轨迹 ' +
      events
        .filter((e) => e.type === 'tool.completed')
        .map((e) => (e.payload as { toolName: string }).toolName)
        .join(' -> '),
  )
}

async function scenario2(): Promise<void> {
  line('场景二 七天无理由退货 全闭环到账')
  const system = compose([
    { kind: 'tool_call', tool: 'get_order', args: { orderNo: 'SO-2026-0003' }, reason: '查订单' },
    {
      kind: 'action',
      intent: 'submit_return',
      slots: { orderNo: 'SO-2026-0003', reason: 'no_reason' },
      reason: '无理由退货',
    },
    {
      kind: 'final',
      answer: '退货单已创建 寄回商品收到后退款',
      escalated: false,
      summary: '退货创建',
    },
  ])
  const { runId, toolContext } = await newRun(
    system,
    C1001,
    '订单 SO-2026-0003 不想要了 退货',
    null,
  )
  await system.runner.start(runId, '退货', toolContext)
  // 买家寄回 卖家收货 触发联动退款
  await system.executor.execute(
    'record_return_shipment',
    { returnNo: 'RT-2026-0002', trackingNo: 'SF-RETURN-001' },
    { ...toolContext, actor: C1001 },
  )
  const received = await system.executor.execute(
    'receive_return_goods',
    { returnNo: 'RT-2026-0002' },
    { ...toolContext, actor: operator },
  )
  console.log(`收货联动结果 ${JSON.stringify(received)}`)
  console.log(`网关成功扣款 ${system.gateway.totalSuccessfulCharges()} 次`)
}

async function scenario3(): Promise<void> {
  line('场景三 大额退款 人工审批链路')
  const system = compose([
    { kind: 'tool_call', tool: 'get_order', args: { orderNo: 'SO-2026-0001' }, reason: '查订单' },
    {
      kind: 'action',
      intent: 'submit_refund_only',
      slots: { orderNo: 'SO-2026-0001', reason: 'unshipped_cancel' },
      reason: '大额退款',
    },
    {
      kind: 'final',
      answer: '审批已通过 退款将原路退回',
      escalated: false,
      summary: '大额退款完成',
    },
  ])
  const { runId, toolContext } = await newRun(system, C1001, '订单 SO-2026-0001 退款', null)
  const outcome = await system.runner.start(runId, '退款', toolContext)
  console.log(`暂停等待审批 ${outcome === 'awaiting_approval'}`)
  const pending = await system.approvalService.listPending()
  console.log(`待审批 ${pending.length} 条 金额 ${(pending[0]?.amountCents ?? 0) / 100} 元`)
  await system.approvalService.decide(supervisor, pending[0]!.approvalId, 'approved')
  const resumed = await system.runner.resumeAfterApproval(
    runId,
    pending[0]!.approvalId,
    'approved',
    'supervisor',
    toolContext,
  )
  console.log(`审批后运行结果 ${resumed}  网关扣款 ${system.gateway.totalSuccessfulCharges()} 次`)
}

async function scenario4(): Promise<void> {
  line('场景四 退款执行中进程中断 断点恢复')
  const system = compose([
    { kind: 'tool_call', tool: 'get_order', args: { orderNo: 'SO-2026-0009' }, reason: '查订单' },
    {
      kind: 'action',
      intent: 'submit_refund_only',
      slots: { orderNo: 'SO-2026-0009', reason: 'unshipped_cancel' },
      reason: '退款',
    },
    { kind: 'final', answer: '退款已完成', escalated: false, summary: '恢复后完成' },
  ])
  const faults = new FaultController([{ tool: 'execute_refund', fault: 'crash', times: 1 }])
  const { runId, toolContext } = await newRun(system, C1002, '订单 SO-2026-0009 退款', faults)
  try {
    await system.runner.start(runId, '退款', toolContext)
  } catch {
    console.log('进程在退款执行中中断 未写失败状态')
  }
  const outcome = await system.runner.resumeFromCheckpoint(runId, { ...toolContext, faults: null })
  console.log(
    `断点恢复结果 ${outcome}  网关扣款 ${system.gateway.totalSuccessfulCharges()} 次 不多不少`,
  )
}

async function scenario5(): Promise<void> {
  line('场景五 重复退款请求被幂等拦截')
  const system = compose([
    {
      kind: 'action',
      intent: 'submit_refund_only',
      slots: { orderNo: 'SO-2026-0009', reason: 'unshipped_cancel' },
      reason: '第一次退款',
    },
    {
      kind: 'action',
      intent: 'submit_refund_only',
      slots: { orderNo: 'SO-2026-0009', reason: 'unshipped_cancel' },
      reason: '重复提交',
    },
    {
      kind: 'final',
      answer: '退款已完成 重复提交被系统拦截',
      escalated: false,
      summary: '幂等拦截',
    },
  ])
  const { runId, toolContext } = await newRun(system, C1002, '退款 而且再操作一次', null)
  const outcome = await system.runner.start(runId, '退款', toolContext)
  const refunds = system.queryTable('refunds', { order_no: 'SO-2026-0009' })
  console.log(
    `运行结果 ${outcome}  退款单 ${refunds.length} 笔  网关扣款 ${system.gateway.totalSuccessfulCharges()} 次`,
  )
}

async function main(): Promise<void> {
  console.log('\x1b[1mAfterSales Copilot 离线演示\x1b[0m')
  console.log(`全部场景使用脚本化模型与冻结时钟 ${BASELINE_FROZEN_TIME}`)
  await scenario1()
  await scenario2()
  await scenario3()
  await scenario4()
  await scenario5()
  console.log(`\n\x1b[36m${'─'.repeat(56)}\x1b[0m`)
  console.log('演示完成 完整评测请运行 pnpm eval')
}

await main()
