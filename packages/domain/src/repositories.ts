/**
 * 仓储接口与外部系统端口
 *
 * 领域只依赖接口 具体存储由 persistence 包实现
 * 这层接缝保证 SQLite 与未来 PostgreSQL 可以互换 也让领域测试无需数据库
 */

import type { ToolErrorShape, EventType } from '@aftersales/contracts'
import type {
  AgentRunRecord,
  ApprovalRequest,
  AuditLog,
  Checkpoint,
  Customer,
  Order,
  PolicyRule,
  Refund,
  ReturnRequest,
  Shipment,
  ToolExecutionRecord,
} from './entities.js'

/** 业务单号生成器 计数器落库 保证同一快照内单号可预测 */
export interface BusinessNoGenerator {
  nextNo(prefix: string): string
}

export interface CustomerRepository {
  findById(customerId: string): Promise<Customer | null>
  countOrders(customerId: string): Promise<number>
}

export interface OrderRepository {
  findByOrderNo(orderNo: string): Promise<Order | null>
  updateVersion(orderNo: string): Promise<void>
}

export interface ShipmentRepository {
  findByOrderNo(orderNo: string): Promise<Shipment | null>
}

export interface ReturnRepository {
  create(record: ReturnRequest): Promise<void>
  findByReturnNo(returnNo: string): Promise<ReturnRequest | null>
  listByOrderNo(orderNo: string): Promise<ReturnRequest[]>
  update(record: ReturnRequest): Promise<void>
}

export interface RefundRepository {
  create(record: Refund): Promise<void>
  findByRefundNo(refundNo: string): Promise<Refund | null>
  findByReturnNo(returnNo: string): Promise<Refund | null>
  update(record: Refund): Promise<void>
}

export interface ApprovalRepository {
  create(record: ApprovalRequest): Promise<void>
  findById(approvalId: string): Promise<ApprovalRequest | null>
  findByResource(resourceType: string, resourceId: string): Promise<ApprovalRequest | null>
  listPending(): Promise<ApprovalRequest[]>
  update(record: ApprovalRequest): Promise<void>
}

export interface PolicyRepository {
  listRules(version: string): Promise<PolicyRule[]>
}

export interface AuditRepository {
  append(entry: Omit<AuditLog, 'id'>): Promise<void>
  listByRunId(runId: string): Promise<AuditLog[]>
  listByResource(resourceType: string, resourceId: string): Promise<AuditLog[]>
}

/** 事件仓储 run 内单调序号由实现层在事务内分配 */
export interface EventRepository {
  append(runId: string, type: EventType, payload: unknown): Promise<number>
  listByRun(
    runId: string,
    fromSequence?: number,
  ): Promise<
    Array<{ runId: string; sequence: number; type: EventType; payload: unknown; createdAt: string }>
  >
}

export interface ToolExecutionRepository {
  create(record: Omit<ToolExecutionRecord, 'id'>): Promise<void>
  listByRunId(runId: string): Promise<ToolExecutionRecord[]>
  listAll(): Promise<ToolExecutionRecord[]>
}

export interface CheckpointRepository {
  save(runId: string, stepId: string, state: Record<string, unknown>): Promise<void>
  latest(runId: string): Promise<Checkpoint | null>
  listByRunId(runId: string): Promise<Checkpoint[]>
}

export interface IdempotencyRepository {
  find(key: string): Promise<{ key: string; result: Record<string, unknown> } | null>
  record(key: string, result: Record<string, unknown>): Promise<void>
}

export interface AgentRunRepository {
  create(record: AgentRunRecord): Promise<void>
  findById(runId: string): Promise<AgentRunRecord | null>
  update(record: AgentRunRecord): Promise<void>
  list(options?: {
    status?: string
    customerId?: string
    limit?: number
  }): Promise<AgentRunRecord[]>
}

/** 租约 防止同一资源被并发执行 双实例部署时也成立 */
export interface LeaseRepository {
  acquire(holder: string, resourceType: string, resourceId: string, ttlMs: number): Promise<boolean>
  release(holder: string, resourceType: string, resourceId: string): Promise<void>
}

/**
 * 支付网关端口
 *
 * 真实系统对接支付宝微信等渠道 这里用 mock 实现
 * 网关必须支持幂等键 相同键的重复请求返回同一结果且只扣款一次
 */
export interface PaymentGatewayPort {
  withRefund(
    idempotencyKey: string,
    request: { refundNo: string; amountCents: number; currency: string; channel: string },
  ): Promise<{ gatewayRefundId: string }>
  /** 评测与演示用 读取网关侧成功扣款次数 */
  chargeCount(idempotencyKey: string): number
  totalSuccessfulCharges(): number
}

/** 领域错误 统一携带契约错误码 */
export class DomainError extends Error {
  constructor(public readonly shape: ToolErrorShape) {
    super(shape.message)
    this.name = 'DomainError'
  }
}
