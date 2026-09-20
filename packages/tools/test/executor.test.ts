/**
 * 执行器与工具行为测试
 *
 * 覆盖 故障注入 重试 超时 越权 轨迹记录与幂等
 */

import { describe, expect, it } from 'vitest'
import { testing } from '@aftersales/domain'
import { ProcessCrashError, ToolExecutionError } from '../src/index.js'
import {
  composeTestSystem,
  seedDeliveredOrder,
  customerActor,
  operatorActor,
  contextFor,
} from './helpers.js'
import { FaultController } from '../src/registry.js'

describe('只读工具', () => {
  it('get_order 返回订单并记录轨迹', async () => {
    const c = composeTestSystem()
    seedDeliveredOrder(c)
    const result = await c.executor.execute(
      'get_order',
      { orderNo: 'SO-2026-0003' },
      contextFor(customerActor),
    )
    expect(result.orderNo).toBe('SO-2026-0003')
    expect(c.repos.toolExecutionRepo.records).toHaveLength(1)
    expect(c.repos.toolExecutionRepo.records[0]?.status).toBe('succeeded')
  })

  it('客户查询他人订单被拒绝且留下失败轨迹', async () => {
    const c = composeTestSystem()
    seedDeliveredOrder(c)
    const attacker = { role: 'customer' as const, customerId: 'C9999' }
    await expect(
      c.executor.execute('get_order', { orderNo: 'SO-2026-0003' }, contextFor(attacker)),
    ).rejects.toThrow('无权访问该订单')
    expect(c.repos.toolExecutionRepo.records[0]?.status).toBe('failed')
    expect(c.repos.toolExecutionRepo.records[0]?.errorCode).toBe('AUTHORIZATION_DENIED')
  })

  it('非法参数在校验阶段被拒绝 不进入执行', async () => {
    const c = composeTestSystem()
    await expect(
      c.executor.execute('get_order', {}, contextFor(customerActor)),
    ).rejects.toBeInstanceOf(ToolExecutionError)
    expect(c.repos.toolExecutionRepo.records).toHaveLength(0)
  })
})

describe('故障注入与重试', () => {
  it('限流故障一次后重试成功 轨迹记录两次尝试', async () => {
    const c = composeTestSystem([{ tool: 'get_order', fault: 'rate_limited', times: 1 }])
    seedDeliveredOrder(c)
    const result = await c.executor.execute(
      'get_order',
      { orderNo: 'SO-2026-0003' },
      contextFor(customerActor, 'run_t1', c.faults),
    )
    expect(result.orderNo).toBe('SO-2026-0003')
    const records = c.repos.toolExecutionRepo.records
    expect(records).toHaveLength(2)
    expect(records[0]?.errorCode).toBe('RATE_LIMITED')
    expect(records[1]?.status).toBe('succeeded')
  })

  it('超时故障触发超时守卫并重试成功', async () => {
    const c = composeTestSystem([{ tool: 'get_order', fault: 'timeout', times: 1 }], 100)
    seedDeliveredOrder(c)
    const result = await c.executor.execute(
      'get_order',
      { orderNo: 'SO-2026-0003' },
      contextFor(customerActor, 'run_t2', c.faults),
    )
    expect(result.orderNo).toBe('SO-2026-0003')
    const records = c.repos.toolExecutionRepo.records
    expect(records[0]?.errorCode).toBe('TIMEOUT')
    expect(records[1]?.status).toBe('succeeded')
  })

  it('连续两次上游故障后放弃 抛出上游错误', async () => {
    const c = composeTestSystem([{ tool: 'get_order', fault: 'server_error', times: 3 }])
    seedDeliveredOrder(c)
    await expect(
      c.executor.execute(
        'get_order',
        { orderNo: 'SO-2026-0003' },
        contextFor(customerActor, 'run_t3', c.faults),
      ),
    ).rejects.toThrow('渠道服务异常')
    expect(c.repos.toolExecutionRepo.records).toHaveLength(2)
    expect(c.repos.toolExecutionRepo.records.every((r) => r.status === 'failed')).toBe(true)
  })

  it('crash 故障抛进程中断且不写失败轨迹', async () => {
    const c = composeTestSystem([{ tool: 'get_order', fault: 'crash', times: 1 }])
    seedDeliveredOrder(c)
    await expect(
      c.executor.execute(
        'get_order',
        { orderNo: 'SO-2026-0003' },
        contextFor(customerActor, 'run_t4', c.faults),
      ),
    ).rejects.toBeInstanceOf(ProcessCrashError)
    // crash 不产生 completed 轨迹 只有 requested 事件
    expect(c.repos.toolExecutionRepo.records).toHaveLength(0)
  })
})

describe('副作用工具', () => {
  it('create_return_request 经工具路径完成政策判定', async () => {
    const c = composeTestSystem()
    seedDeliveredOrder(c)
    const result = await c.executor.execute(
      'create_return_request',
      { orderNo: 'SO-2026-0003', type: 'return', reason: 'no_reason' },
      contextFor(customerActor),
    )
    expect(result.policyOutcome).toBe('allow')
    expect(result.status).toBe('awaiting_buyer_shipment')
  })

  it('execute_refund 经工具路径幂等 网关只扣款一次', async () => {
    const c = composeTestSystem()
    c.repos.orderRepo.orders.set('SO-2026-0009', makePaidOrder())
    const created = await c.executor.execute(
      'create_return_request',
      { orderNo: 'SO-2026-0009', type: 'refund_only', reason: 'unshipped_cancel' },
      contextFor({ role: 'customer', customerId: 'C1001' }),
    )
    const first = await c.executor.execute(
      'execute_refund',
      { returnNo: created.returnNo as string },
      contextFor({ role: 'customer', customerId: 'C1001' }),
    )
    expect(first.status).toBe('succeeded')
    const second = await c.executor.execute(
      'execute_refund',
      { returnNo: created.returnNo as string },
      contextFor({ role: 'customer', customerId: 'C1001' }),
    )
    expect(second.status).toBe('succeeded')
    expect(c.repos.gateway.totalSuccessfulCharges()).toBe(1)
  })

  it('客户不能调用运营工具 receive_return_goods', async () => {
    const c = composeTestSystem()
    await expect(
      c.executor.execute(
        'receive_return_goods',
        { returnNo: 'RT-2026-0002' },
        contextFor(customerActor),
      ),
    ).rejects.toThrow('确认收货仅限售后专员操作')
  })

  it('操作员可以查询任意订单', async () => {
    const c = composeTestSystem()
    seedDeliveredOrder(c)
    const result = await c.executor.execute(
      'get_order',
      { orderNo: 'SO-2026-0003' },
      contextFor(operatorActor),
    )
    expect(result.orderNo).toBe('SO-2026-0003')
  })
})

describe('故障控制器', () => {
  it('倒计时耗尽后不再注入', () => {
    const controller = new FaultController([{ tool: 'get_order', fault: 'rate_limited', times: 2 }])
    expect(controller.consume('get_order')).toBe('rate_limited')
    expect(controller.consume('get_order')).toBe('rate_limited')
    expect(controller.consume('get_order')).toBeNull()
  })

  it('不同工具互不影响', () => {
    const controller = new FaultController([{ tool: 'get_order', fault: 'crash', times: 1 }])
    expect(controller.consume('get_shipment')).toBeNull()
    expect(controller.consume('get_order')).toBe('crash')
  })
})

/** 已支付未发货的小额订单 */
function makePaidOrder() {
  return testing.makeTestOrder({
    orderNo: 'SO-2026-0009',
    customerId: 'C1001',
    status: 'paid',
    totalAmountCents: 8_900,
    shippedAt: null,
    deliveredAt: null,
  })
}
