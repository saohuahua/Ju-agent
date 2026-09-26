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
  Compensation,
  Customer,
  Order,
  PolicyArticle,
  PolicyRule,
  PriceProtection,
  Refund,
  ReturnRequest,
  RunRating,
  RunSource,
  Shipment,
  SkuPrice,
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
  /** 乐观锁更新 物流事件注入与收货登记共用 */
  update(record: Shipment): Promise<void>
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

export interface ApprovalDecisionWrite {
  approvalId: string
  decision: 'approved' | 'rejected'
  decidedBy: string
  now: string
  /** 指定运行时同时校验归属与等待状态并持久化执行意图 */
  runId?: string
  /** HTTP 受理时绑定已核验断点 防止核验后恢复方案被替换 */
  checkpointId?: number
}

export interface ApprovalRepository {
  create(record: ApprovalRequest): Promise<void>
  findById(approvalId: string): Promise<ApprovalRequest | null>
  findByResource(resourceType: string, resourceId: string): Promise<ApprovalRequest | null>
  listPending(): Promise<ApprovalRequest[]>
  decidePending(input: ApprovalDecisionWrite): Promise<ApprovalRequest | null>
  consumeToken(
    approvalId: string,
    token: string,
    resourceType: string,
    resourceId: string,
    now: string,
  ): Promise<boolean>
}

export interface CompensationRepository {
  create(record: Compensation): Promise<void>
  findByCompensationNo(compensationNo: string): Promise<Compensation | null>
  listByOrderNo(orderNo: string): Promise<Compensation[]>
  update(record: Compensation): Promise<void>
}

export interface PriceProtectionRepository {
  create(record: PriceProtection): Promise<void>
  findByProtectionNo(protectionNo: string): Promise<PriceProtection | null>
  listByOrderNo(orderNo: string): Promise<PriceProtection[]>
  update(record: PriceProtection): Promise<void>
}

/** 商品当前售价 价保差额计算的参照价 只读 */
export interface SkuPriceRepository {
  listBySkus(skus: string[]): Promise<SkuPrice[]>
}

export interface PolicyRepository {
  listRules(version: string): Promise<PolicyRule[]>
}

/** 政策语料条款仓储 检索打分前的全量读取 */
export interface PolicyArticleRepository {
  listByVersion(version: string): Promise<PolicyArticle[]>
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
  transition(record: AgentRunRecord, expectedStatus: AgentRunRecord['status']): Promise<boolean>
  setIntent(runId: string, intent: string, updatedAt: string): Promise<void>
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
  /**
   * deduped 为 true 表示网关按幂等键命中了已有结果 未产生新的成功扣款
   * 只有业务幂等记录意外丢失（如进程在网关成功与落记录之间崩溃）时才会出现
   * 是三道防线的最后一道 该标志向上传播供审计与 guard.blocked 事件使用
   */
  withRefund(
    idempotencyKey: string,
    request: { refundNo: string; amountCents: number; currency: string; channel: string },
  ): Promise<{ gatewayRefundId: string; deduped: boolean }>
  /** 评测与演示用 读取网关侧成功扣款次数 */
  chargeCount(idempotencyKey: string): number
  totalSuccessfulCharges(): number
}

/** 满意度评分 一 run 一评 幂等拒绝 */
export interface RatingRepository {
  create(record: RunRating): Promise<void>
  findByRunId(runId: string): Promise<RunRating | null>
}

/**
 * 运营分析读模型端口
 *
 * 聚合查询的 SQL 实现留在持久层 领域只关心口径
 * source=customer 是运营指标的唯一口径 评测与模拟会话不进聚合
 */
export interface AnalyticsReadModel {
  runStatusCounts(source: RunSource): Promise<Array<{ status: string; count: number }>>
  runsByDay(source: RunSource, days: number): Promise<Array<{ day: string; count: number }>>
  /** 平均模型轮次 agent.turn 事件按 run 平均 */
  avgTurns(source: RunSource): Promise<number>
  /** 发生过升级的会话数 run.escalated 事件按 run 去重 */
  escalatedRunCount(source: RunSource): Promise<number>
  toolDistribution(
    source: RunSource,
  ): Promise<Array<{ toolName: string; total: number; failed: number }>>
  /** 已决审批的平均时效毫秒 */
  avgApprovalLatencyMs(): Promise<number | null>
  decidedApprovalCount(): Promise<number>
  ratingCounts(): Promise<Array<{ score: number; count: number }>>
  /** CSAT 与会话终态交叉 人工解决与 AI 解决的满意度对照 */
  ratingByFinalStatus(): Promise<Array<{ status: string; avgScore: number; count: number }>>
  ratingCount(): Promise<number>
}

/** 领域错误 统一携带契约错误码 */
export class DomainError extends Error {
  constructor(public readonly shape: ToolErrorShape) {
    super(shape.message)
    this.name = 'DomainError'
  }
}
