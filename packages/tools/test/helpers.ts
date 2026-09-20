/**
 * 工具层测试脚手架
 *
 * 用领域内存实现组装最小系统 聚焦执行器行为
 * 不依赖 SQLite 真实仓储
 */

import { AfterSaleService } from '@aftersales/domain'
import { ApprovalService } from '@aftersales/domain'
import { AuditService } from '@aftersales/domain'
import { FrozenClock } from '@aftersales/domain'
import { testing } from '@aftersales/domain'
import type { Actor } from '@aftersales/domain'
import { buildToolRegistry } from '../src/tool-definitions.js'
import { ToolExecutor } from '../src/executor.js'
import { FaultController, type FaultPlanEntry, type ToolRegistry } from '../src/registry.js'
import type { ToolContext } from '../src/registry.js'

export const TEST_TIME = '2026-09-20T12:00:00.000Z'

export function composeTestSystem(faults: FaultPlanEntry[] = [], timeoutOverrideMs?: number) {
  const repos = testing.createInMemoryRepositories()
  const clock = new FrozenClock(TEST_TIME)
  const auditService = new AuditService(repos.auditRepo, clock)
  const approvalService = new ApprovalService(repos.approvalRepo, clock)
  const afterSaleService = new AfterSaleService(
    repos.orderRepo,
    repos.shipmentRepo,
    repos.returnRepo,
    repos.refundRepo,
    repos.approvalRepo,
    repos.idempotencyRepo,
    repos.gateway,
    repos.noGenerator,
    approvalService,
    auditService,
    clock,
  )
  const registry: ToolRegistry = buildToolRegistry({
    customerRepo: repos.customerRepo,
    orderRepo: repos.orderRepo,
    shipmentRepo: repos.shipmentRepo,
    policyRepo: repos.policyRepo,
    afterSaleService,
    auditService,
  })
  const executor = new ToolExecutor({
    registry,
    toolExecutionRepo: repos.toolExecutionRepo,
    eventRepo: repos.eventRepo,
    clock,
    timeoutOverrideMs,
  })
  const faultController = new FaultController(faults)
  return {
    repos,
    clock,
    registry,
    executor,
    afterSaleService,
    auditService,
    approvalService,
    faults: faultController,
  }
}

export function contextFor(
  actor: Actor,
  runId: string | null = 'run_test',
  faults: FaultController | null = null,
): ToolContext {
  return { actor, runId, faults }
}

/** 种子一条已签收订单 */
export function seedDeliveredOrder(c: ReturnType<typeof composeTestSystem>) {
  c.repos.orderRepo.orders.set(
    'SO-2026-0003',
    testing.makeTestOrder({
      orderNo: 'SO-2026-0003',
      customerId: 'C1001',
      status: 'delivered',
      deliveredAt: '2026-09-15T12:00:00.000Z',
    }),
  )
  c.repos.customerRepo.customers.set('C1001', {
    customerId: 'C1001',
    name: '张伟',
    phoneMasked: '138****1234',
    createdAt: '2026-08-01T00:00:00.000Z',
  })
}

export const customerActor: Actor = { role: 'customer', customerId: 'C1001' }
export const operatorActor: Actor = { role: 'operator' }
