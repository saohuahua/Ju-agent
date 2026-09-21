/**
 * 系统组合根
 *
 * 把仓储 服务 工具 工作流 Agent 循环装配成一个可运行系统
 * 评测与 API 共用这一份装配 保证评测环境与运行环境完全一致
 * 这是依赖倒置的收口点 上层只拿装配结果 不关心内部构造
 */

import {
  AfterSaleService,
  ApprovalService,
  AuditService,
  CompensationService,
  LogisticsEventService,
  RunService,
  type Actor,
  type Clock,
} from '@aftersales/domain'
import { AgentRunner } from '@aftersales/agent'
import type { ChatModel } from '@aftersales/agent'
import {
  BASELINE_FROZEN_TIME,
  SqliteAgentRunRepository,
  SqliteApprovalRepository,
  SqliteAuditRepository,
  SqliteBusinessNoGenerator,
  SqliteCheckpointRepository,
  SqliteCompensationRepository,
  SqliteCustomerRepository,
  SqliteEventRepository,
  SqliteIdempotencyRepository,
  SqliteLeaseRepository,
  SqliteOrderRepository,
  SqlitePolicyRepository,
  SqliteRefundRepository,
  SqliteReturnRepository,
  SqliteShipmentRepository,
  SqliteToolExecutionRepository,
  createMemoryDatabase,
  loadFixture,
  openDatabase,
  queryTable,
  type FixturePatch,
  type SqliteDatabase,
} from '@aftersales/persistence'
import { MockPaymentGateway, ToolExecutor, buildToolRegistry } from '@aftersales/tools'
import { WorkflowEngine } from '@aftersales/workflow'

export interface ComposeOptions {
  /** SQLite 数据库路径 :memory: 为内存库 缺省内存库 */
  dbPath?: string
  /** 已有连接传入时忽略 dbPath 评测复用连接自建库 */
  db?: SqliteDatabase
  clock: Clock
  model: ChatModel
  /** 评测用超时覆盖 毫秒 */
  timeoutOverrideMs?: number
  /** Agent 单轮最大模型调用次数 */
  maxSteps?: number
  /** 是否载入基线夹具 */
  withFixture?: boolean
  /** 夹具补丁 */
  fixturePatch?: FixturePatch[]
}

/** 装配完成的系统句柄 */
export interface ComposedSystem {
  db: SqliteDatabase
  clock: Clock
  gateway: MockPaymentGateway
  runService: RunService
  approvalService: ApprovalService
  afterSaleService: AfterSaleService
  compensationService: CompensationService
  logisticsService: LogisticsEventService
  executor: ToolExecutor
  engine: WorkflowEngine
  runner: AgentRunner
  /** 事件仓储 SSE 与事件查询共用 */
  eventRepo: SqliteEventRepository
  /** 评测断言用 按表白名单查行 */
  queryTable: (table: string, where?: Record<string, unknown>) => Array<Record<string, unknown>>
}

export function composeSystem(options: ComposeOptions): ComposedSystem {
  const db = options.db ?? (options.dbPath ? openDatabase(options.dbPath) : createMemoryDatabase())
  const clock = options.clock

  if (options.withFixture !== false) {
    loadFixture(db, options.fixturePatch ?? [])
  }

  const gateway = new MockPaymentGateway()
  const auditService = new AuditService(new SqliteAuditRepository(db), clock)
  const approvalService = new ApprovalService(new SqliteApprovalRepository(db), clock)
  const afterSaleService = new AfterSaleService(
    new SqliteOrderRepository(db),
    new SqliteShipmentRepository(db),
    new SqliteReturnRepository(db),
    new SqliteRefundRepository(db),
    new SqliteApprovalRepository(db),
    new SqliteIdempotencyRepository(db),
    gateway,
    new SqliteBusinessNoGenerator(db),
    approvalService,
    auditService,
    clock,
  )
  const compensationService = new CompensationService(
    new SqliteOrderRepository(db),
    new SqliteCompensationRepository(db),
    new SqliteIdempotencyRepository(db),
    gateway,
    new SqliteBusinessNoGenerator(db),
    approvalService,
    auditService,
    clock,
  )
  const runService = new RunService(
    new SqliteAgentRunRepository(db),
    new SqliteEventRepository(db),
    clock,
  )
  const eventRepo = new SqliteEventRepository(db)
  const logisticsService = new LogisticsEventService(
    new SqliteShipmentRepository(db),
    new SqliteOrderRepository(db),
    auditService,
    clock,
  )

  const registry = buildToolRegistry({
    customerRepo: new SqliteCustomerRepository(db),
    orderRepo: new SqliteOrderRepository(db),
    shipmentRepo: new SqliteShipmentRepository(db),
    policyRepo: new SqlitePolicyRepository(db),
    afterSaleService,
    compensationService,
    auditService,
  })
  const executor = new ToolExecutor({
    registry,
    toolExecutionRepo: new SqliteToolExecutionRepository(db),
    eventRepo: new SqliteEventRepository(db),
    clock,
    timeoutOverrideMs: options.timeoutOverrideMs,
  })
  const engine = new WorkflowEngine({
    afterSaleService,
    compensationService,
    approvalService,
    runService,
    executor,
    checkpointRepo: new SqliteCheckpointRepository(db),
    leaseRepo: new SqliteLeaseRepository(db),
    clock,
  })
  const runner = new AgentRunner({
    model: options.model,
    executor,
    workflow: engine,
    runs: runService,
    eventRepo,
    clock,
    maxSteps: options.maxSteps ?? 12,
  })

  return {
    db,
    clock,
    gateway,
    runService,
    approvalService,
    afterSaleService,
    compensationService,
    logisticsService,
    executor,
    engine,
    runner,
    eventRepo,
    queryTable: (table, where) => queryTable(db, table, where),
  }
}

/** 评测基准时刻 与夹具数据锚定的冻结时间一致 */
export { BASELINE_FROZEN_TIME }

/** 组合根便捷构造操作身份 */
export function customerActor(customerId: string): Actor {
  return { role: 'customer', customerId }
}

export function operatorActor(): Actor {
  return { role: 'operator' }
}

export function supervisorActor(): Actor {
  return { role: 'supervisor' }
}
