/**
 * Agent 测试脚手架
 *
 * 组装完整运行时 内存仓储 脚本化模型 工作流引擎与运行循环
 */

import {
  AfterSaleService,
  ApprovalService,
  AuditService,
  FrozenClock,
  RunService,
  testing,
} from '@aftersales/domain'
import type { Actor, Order } from '@aftersales/domain'
import { buildToolRegistry, ToolExecutor } from '@aftersales/tools'
import { WorkflowEngine } from '@aftersales/workflow'
import { AgentRunner } from '../src/agent.js'
import { ScriptedModel } from '../src/scripted-model.js'
import type { AgentOutput } from '@aftersales/contracts'

export const AGENT_TEST_TIME = '2026-09-20T12:00:00.000Z'

export function composeAgentSystem(script: AgentOutput[], maxSteps = 8) {
  const repos = testing.createInMemoryRepositories()
  const clock = new FrozenClock(AGENT_TEST_TIME)
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
    timeoutOverrideMs: 200,
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
  const model = new ScriptedModel(script)
  const runner = new AgentRunner({
    model,
    executor,
    workflow: engine,
    runs: runService,
    eventRepo: repos.eventRepo,
    clock,
    maxSteps,
  })
  return { repos, clock, runService, engine, runner, model, approvalService }
}

export async function startRun(
  system: ReturnType<typeof composeAgentSystem>,
  actor: Actor,
  message: string,
) {
  const run = await system.runService.start({
    customerId: actor.customerId ?? 'C1001',
    promptVersion: 'v1',
    model: 'scripted',
  })
  const outcome = await system.runner.start(run.runId, message, {
    actor,
    runId: run.runId,
    faults: null,
  })
  return { runId: run.runId, outcome }
}

export function seedOrder(
  repos: ReturnType<typeof testing.createInMemoryRepositories>,
  order: Partial<Order>,
) {
  const record = testing.makeTestOrder({ customerId: 'C1001', ...order })
  repos.orderRepo.orders.set(record.orderNo, record)
}
