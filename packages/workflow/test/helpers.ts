/**
 * 工作流测试脚手架
 *
 * 手动组装 领域内存仓储 服务 工具注册表 执行器 引擎
 * 组装顺序即真实装配顺序 也是 api 与 eval 组合根的参考实现
 */

import {
  AfterSaleService,
  ApprovalService,
  AuditService,
  FrozenClock,
  RunService,
  testing,
} from '@aftersales/domain'
import type { Actor } from '@aftersales/domain'
import { buildToolRegistry } from '@aftersales/tools'
import { ToolExecutor } from '@aftersales/tools'
import { WorkflowEngine } from '../src/engine.js'
import type { ToolContext } from '@aftersales/tools'

export const WORKFLOW_TEST_TIME = '2026-09-20T12:00:00.000Z'

export function composeWorkflowSystem(timeoutOverrideMs?: number) {
  const repos = testing.createInMemoryRepositories()
  const clock = new FrozenClock(WORKFLOW_TEST_TIME)
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
  const runService = new RunService(repos.runRepo, repos.eventRepo, clock)
  const registry = buildToolRegistry({
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
  const engine = new WorkflowEngine({
    afterSaleService,
    approvalService,
    runService,
    executor,
    checkpointRepo: repos.checkpointRepo,
    leaseRepo: repos.leaseRepo,
    clock,
  })
  return { repos, clock, runService, engine, afterSaleService, approvalService, auditService }
}

/** 建一条运行记录 并返回其工具上下文 */
export async function createTestRun(
  system: ReturnType<typeof composeWorkflowSystem>,
  actor: Actor,
): Promise<{ runId: string; toolContext: ToolContext }> {
  const run = await system.runService.start({
    customerId: actor.customerId ?? 'C1001',
    promptVersion: 'test',
    model: 'scripted',
  })
  await system.runService.transition(run.runId, 'running')
  return { runId: run.runId, toolContext: { actor, runId: run.runId, faults: null } }
}

/** 种子一条已签收订单 归属 C1001 */
export function seedDeliveredOrder(system: ReturnType<typeof composeWorkflowSystem>) {
  system.repos.orderRepo.orders.set(
    'SO-2026-0003',
    testing.makeTestOrder({
      orderNo: 'SO-2026-0003',
      customerId: 'C1001',
      status: 'delivered',
      deliveredAt: '2026-09-15T12:00:00.000Z',
    }),
  )
}

/** 种子一条未发货大额订单 归属 C1001 触发审批阈值 */
export function seedLargeUnshippedOrder(system: ReturnType<typeof composeWorkflowSystem>) {
  system.repos.orderRepo.orders.set(
    'SO-2026-0001',
    testing.makeTestOrder({
      orderNo: 'SO-2026-0001',
      customerId: 'C1001',
      status: 'paid',
      totalAmountCents: 699_900,
      shippedAt: null,
      deliveredAt: null,
    }),
  )
}
