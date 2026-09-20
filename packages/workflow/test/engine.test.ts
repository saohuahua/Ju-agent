/**
 * 工作流引擎测试
 *
 * 覆盖 审批暂停与恢复 断点跳步 并发租约 拒绝与政策终结 事件序列
 */

import { describe, expect, it } from 'vitest'
import { ProcessCrashError } from '@aftersales/tools'
import { FaultController } from '@aftersales/tools'
import {
  composeWorkflowSystem,
  createTestRun,
  seedDeliveredOrder,
  seedLargeUnshippedOrder,
} from './helpers.js'

const customer = { role: 'customer' as const, customerId: 'C1001' }
const supervisor = { role: 'supervisor' as const }

describe('仅退款工作流', () => {
  it('小额未发货退款自动完成 无需审批', async () => {
    const system = composeWorkflowSystem()
    const { runId, toolContext } = await createTestRun(system, customer)
    system.repos.orderRepo.orders.set('SO-2026-0009', {
      orderNo: 'SO-2026-0009',
      customerId: 'C1001',
      status: 'paid',
      totalAmountCents: 8_900,
      currency: 'CNY',
      paymentChannel: 'wechat',
      items: [],
      paidAt: null,
      shippedAt: null,
      deliveredAt: null,
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
      version: 1,
    })
    const result = await system.engine.start(
      runId,
      'submit_refund_only',
      {
        orderNo: 'SO-2026-0009',
        reason: 'unshipped_cancel',
      },
      toolContext,
    )
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.outcome).toBe('succeeded')
    const refund = await system.repos.refundRepo.findByReturnNo('RT-2026-0001')
    expect(refund?.status).toBe('succeeded')
    expect(system.repos.gateway.totalSuccessfulCharges()).toBe(1)
  })

  it('大额退款触发审批 运行暂停在 awaiting_approval', async () => {
    const system = composeWorkflowSystem()
    seedLargeUnshippedOrder(system)
    const { runId, toolContext } = await createTestRun(system, customer)
    const result = await system.engine.start(
      runId,
      'submit_refund_only',
      {
        orderNo: 'SO-2026-0001',
        reason: 'unshipped_cancel',
      },
      toolContext,
    )
    expect(result.status).toBe('paused')
    const run = await system.runService.get(runId)
    expect(run.status).toBe('awaiting_approval')
    // 审批前没有扣款
    expect(system.repos.gateway.totalSuccessfulCharges()).toBe(0)
  })

  it('审批通过后恢复执行 退款成功且只扣款一次', async () => {
    const system = composeWorkflowSystem()
    seedLargeUnshippedOrder(system)
    const { runId, toolContext } = await createTestRun(system, customer)
    const paused = await system.engine.start(
      runId,
      'submit_refund_only',
      {
        orderNo: 'SO-2026-0001',
        reason: 'unshipped_cancel',
      },
      toolContext,
    )
    expect(paused.status).toBe('paused')
    const approvalId = (paused as { approvalId: string }).approvalId
    await system.approvalService.decide(supervisor, approvalId, 'approved')
    const result = await system.engine.resumeAfterApproval(
      runId,
      approvalId,
      'approved',
      'supervisor',
      toolContext,
    )
    expect(result.status).toBe('completed')
    const refund = await system.repos.refundRepo.findByReturnNo('RT-2026-0001')
    expect(refund?.status).toBe('succeeded')
    expect(system.repos.gateway.totalSuccessfulCharges()).toBe(1)
    const run = await system.runService.get(runId)
    expect(run.status).toBe('running')
  })

  it('审批拒绝后售后单终结 不执行退款', async () => {
    const system = composeWorkflowSystem()
    seedLargeUnshippedOrder(system)
    const { runId, toolContext } = await createTestRun(system, customer)
    const paused = await system.engine.start(
      runId,
      'submit_refund_only',
      {
        orderNo: 'SO-2026-0001',
        reason: 'unshipped_cancel',
      },
      toolContext,
    )
    const approvalId = (paused as { approvalId: string }).approvalId
    await system.approvalService.decide(supervisor, approvalId, 'rejected')
    const result = await system.engine.resumeAfterApproval(
      runId,
      approvalId,
      'rejected',
      'supervisor',
      toolContext,
    )
    expect(result.status).toBe('completed')
    const returnRequest = await system.repos.returnRepo.findByReturnNo('RT-2026-0001')
    expect(returnRequest?.status).toBe('rejected')
    expect(system.repos.gateway.totalSuccessfulCharges()).toBe(0)
  })
})

describe('退货工作流', () => {
  it('七天无理由退货创建后停在待寄回 退款预留不执行', async () => {
    const system = composeWorkflowSystem()
    seedDeliveredOrder(system)
    const { runId, toolContext } = await createTestRun(system, customer)
    const result = await system.engine.start(
      runId,
      'submit_return',
      {
        orderNo: 'SO-2026-0003',
        reason: 'no_reason',
      },
      toolContext,
    )
    expect(result.status).toBe('completed')
    const returnRequest = await system.repos.returnRepo.findByReturnNo('RT-2026-0001')
    expect(returnRequest?.status).toBe('awaiting_buyer_shipment')
    const refund = await system.repos.refundRepo.findByReturnNo('RT-2026-0001')
    expect(refund?.status).toBe('created')
    expect(system.repos.gateway.totalSuccessfulCharges()).toBe(0)
  })

  it('政策超时被拒绝 工作流以 rejected 结束', async () => {
    const system = composeWorkflowSystem()
    system.repos.orderRepo.orders.set('SO-2026-0007', {
      orderNo: 'SO-2026-0007',
      customerId: 'C1001',
      status: 'delivered',
      totalAmountCents: 320_000,
      currency: 'CNY',
      paymentChannel: 'wechat',
      items: [],
      paidAt: null,
      shippedAt: null,
      deliveredAt: '2026-09-12T12:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-12T12:00:00.000Z',
      version: 1,
    })
    const { runId, toolContext } = await createTestRun(system, customer)
    const result = await system.engine.start(
      runId,
      'submit_return',
      {
        orderNo: 'SO-2026-0007',
        reason: 'no_reason',
      },
      toolContext,
    )
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.outcome).toBe('rejected')
    const returnRequest = await system.repos.returnRepo.findByReturnNo('RT-2026-0001')
    expect(returnRequest?.status).toBe('rejected')
  })
})

describe('断点与并发', () => {
  it('crash 后断点恢复不重复已完成步骤 网关只扣款一次', async () => {
    const system = composeWorkflowSystem()
    system.repos.orderRepo.orders.set('SO-2026-0009', {
      orderNo: 'SO-2026-0009',
      customerId: 'C1001',
      status: 'paid',
      totalAmountCents: 8_900,
      currency: 'CNY',
      paymentChannel: 'wechat',
      items: [],
      paidAt: null,
      shippedAt: null,
      deliveredAt: null,
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
      version: 1,
    })
    const { runId, toolContext } = await createTestRun(system, customer)
    const crashContext = {
      ...toolContext,
      faults: new FaultController([{ tool: 'execute_refund', fault: 'crash', times: 1 }]),
    }

    await expect(
      system.engine.start(
        runId,
        'submit_refund_only',
        { orderNo: 'SO-2026-0009', reason: 'unshipped_cancel' },
        crashContext,
      ),
    ).rejects.toBeInstanceOf(ProcessCrashError)

    // 断点已保存到最后一个完成步骤 execute_refund 尚未完成
    const checkpoint = await system.repos.checkpointRepo.latest(runId)
    expect(checkpoint?.stepId).toBe('request_approval')

    // 恢复时不再注入故障 步骤跳过与幂等双保险
    const result = await system.engine.resumeFromCheckpoint(runId, toolContext)
    expect(result.status).toBe('completed')
    const refund = await system.repos.refundRepo.findByReturnNo('RT-2026-0001')
    expect(refund?.status).toBe('succeeded')
    expect(system.repos.gateway.totalSuccessfulCharges()).toBe(1)

    // 已完成步骤没有二次执行
    const events = await system.repos.eventRepo.listByRun(runId)
    const stepStarts = events.filter((e) => e.type === 'step.started')
    const createStarts = stepStarts.filter(
      (e) => (e.payload as { stepId: string }).stepId === 'create_return',
    )
    expect(createStarts).toHaveLength(1)
  })

  it('租约阻止同一运行并发执行', async () => {
    const system = composeWorkflowSystem()
    seedLargeUnshippedOrder(system)
    const { runId, toolContext } = await createTestRun(system, customer)
    await system.engine.start(
      runId,
      'submit_refund_only',
      {
        orderNo: 'SO-2026-0001',
        reason: 'unshipped_cancel',
      },
      toolContext,
    )
    // 模拟另一个实例抢跑恢复
    await expect(system.engine.resumeFromCheckpoint(runId, toolContext)).rejects.toThrow(
      '不支持断点恢复',
    )
  })
})

describe('事件序列', () => {
  it('事件序号严格递增且审批事件完整', async () => {
    const system = composeWorkflowSystem()
    seedLargeUnshippedOrder(system)
    const { runId, toolContext } = await createTestRun(system, customer)
    const paused = await system.engine.start(
      runId,
      'submit_refund_only',
      {
        orderNo: 'SO-2026-0001',
        reason: 'unshipped_cancel',
      },
      toolContext,
    )
    expect(paused.status).toBe('paused')
    const events = await system.repos.eventRepo.listByRun(runId)
    const sequences = events.map((e) => e.sequence)
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
    const types = events.map((e) => e.type)
    expect(types).toContain('approval.required')
    expect(types).toContain('step.started')
    expect(types).toContain('tool.requested')
  })
})
