/**
 * 内存仓储实现
 *
 * 供领域单元测试与轻量回放使用 不依赖任何数据库
 * 与 SQLite 实现形成互证 证明领域层确实不绑定存储
 */

import type { EventType, OrderItem } from '@aftersales/contracts'
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
  Shipment,
  SkuPrice,
  ToolExecutionRecord,
} from './entities.js'
import type {
  AgentRunRepository,
  ApprovalRepository,
  AuditRepository,
  BusinessNoGenerator,
  CheckpointRepository,
  CompensationRepository,
  CustomerRepository,
  EventRepository,
  IdempotencyRepository,
  LeaseRepository,
  OrderRepository,
  PaymentGatewayPort,
  PolicyArticleRepository,
  PolicyRepository,
  PriceProtectionRepository,
  RefundRepository,
  ReturnRepository,
  ShipmentRepository,
  SkuPriceRepository,
  ToolExecutionRepository,
} from './repositories.js'

export class InMemoryOrderRepository implements OrderRepository {
  readonly orders = new Map<string, Order>()
  async findByOrderNo(orderNo: string): Promise<Order | null> {
    return this.orders.get(orderNo) ?? null
  }
  async updateVersion(orderNo: string): Promise<void> {
    const order = this.orders.get(orderNo)
    if (order) order.version += 1
  }
}

export class InMemoryShipmentRepository implements ShipmentRepository {
  readonly shipments = new Map<string, Shipment>()
  async findByOrderNo(orderNo: string): Promise<Shipment | null> {
    return this.shipments.get(orderNo) ?? null
  }
  async update(record: Shipment): Promise<void> {
    const found = this.shipments.get(record.shipmentId)
    if (!found || found.version !== record.version) {
      throw new Error(`运单乐观锁冲突 ${record.shipmentId}`)
    }
    this.shipments.set(record.shipmentId, { ...record, version: record.version + 1 })
  }
}

export class InMemoryCustomerRepository implements CustomerRepository {
  readonly customers = new Map<string, Customer>()
  readonly orderCounts = new Map<string, number>()
  async findById(customerId: string): Promise<Customer | null> {
    return this.customers.get(customerId) ?? null
  }
  async countOrders(customerId: string): Promise<number> {
    return this.orderCounts.get(customerId) ?? 0
  }
}

export class InMemoryReturnRepository implements ReturnRepository {
  readonly returns = new Map<string, ReturnRequest>()
  async create(record: ReturnRequest): Promise<void> {
    this.returns.set(record.returnNo, { ...record })
  }
  async findByReturnNo(returnNo: string): Promise<ReturnRequest | null> {
    const found = this.returns.get(returnNo)
    return found ? { ...found } : null
  }
  async listByOrderNo(orderNo: string): Promise<ReturnRequest[]> {
    return [...this.returns.values()].filter((r) => r.orderNo === orderNo).map((r) => ({ ...r }))
  }
  async update(record: ReturnRequest): Promise<void> {
    this.returns.set(record.returnNo, { ...record })
  }
}

export class InMemoryRefundRepository implements RefundRepository {
  readonly refunds = new Map<string, Refund>()
  async create(record: Refund): Promise<void> {
    this.refunds.set(record.refundNo, { ...record })
  }
  async findByRefundNo(refundNo: string): Promise<Refund | null> {
    const found = this.refunds.get(refundNo)
    return found ? { ...found } : null
  }
  async findByReturnNo(returnNo: string): Promise<Refund | null> {
    const found = [...this.refunds.values()].find((r) => r.returnNo === returnNo)
    return found ? { ...found } : null
  }
  async update(record: Refund): Promise<void> {
    this.refunds.set(record.refundNo, { ...record })
  }
}

export class InMemoryCompensationRepository implements CompensationRepository {
  readonly compensations = new Map<string, Compensation>()
  async create(record: Compensation): Promise<void> {
    this.compensations.set(record.compensationNo, { ...record })
  }
  async findByCompensationNo(compensationNo: string): Promise<Compensation | null> {
    const found = this.compensations.get(compensationNo)
    return found ? { ...found } : null
  }
  async listByOrderNo(orderNo: string): Promise<Compensation[]> {
    return [...this.compensations.values()].filter((c) => c.orderNo === orderNo).map((c) => ({ ...c }))
  }
  async update(record: Compensation): Promise<void> {
    this.compensations.set(record.compensationNo, { ...record })
  }
}

export class InMemoryPriceProtectionRepository implements PriceProtectionRepository {
  readonly protections = new Map<string, PriceProtection>()
  async create(record: PriceProtection): Promise<void> {
    this.protections.set(record.protectionNo, { ...record })
  }
  async findByProtectionNo(protectionNo: string): Promise<PriceProtection | null> {
    const found = this.protections.get(protectionNo)
    return found ? { ...found } : null
  }
  async listByOrderNo(orderNo: string): Promise<PriceProtection[]> {
    return [...this.protections.values()].filter((p) => p.orderNo === orderNo).map((p) => ({ ...p }))
  }
  async update(record: PriceProtection): Promise<void> {
    this.protections.set(record.protectionNo, { ...record })
  }
}

export class InMemorySkuPriceRepository implements SkuPriceRepository {
  readonly prices = new Map<string, SkuPrice>()
  async listBySkus(skus: string[]): Promise<SkuPrice[]> {
    return skus
      .map((sku) => this.prices.get(sku))
      .filter((price): price is SkuPrice => Boolean(price))
      .map((price) => ({ ...price }))
  }
}

export class InMemoryApprovalRepository implements ApprovalRepository {
  readonly approvals = new Map<string, ApprovalRequest>()

  async create(record: ApprovalRequest): Promise<void> {
    this.approvals.set(record.approvalId, { ...record })
  }
  async findById(approvalId: string): Promise<ApprovalRequest | null> {
    const found = this.approvals.get(approvalId)
    return found ? { ...found } : null
  }
  async findByResource(resourceType: string, resourceId: string): Promise<ApprovalRequest | null> {
    const found = [...this.approvals.values()].find(
      (a) => a.resourceType === resourceType && a.resourceId === resourceId,
    )
    return found ? { ...found } : null
  }
  async listPending(): Promise<ApprovalRequest[]> {
    return [...this.approvals.values()].filter((a) => a.status === 'pending').map((a) => ({ ...a }))
  }
  async update(record: ApprovalRequest): Promise<void> {
    this.approvals.set(record.approvalId, { ...record })
  }
}

export class InMemoryPolicyRepository implements PolicyRepository {
  readonly rules: PolicyRule[] = []
  async listRules(version: string): Promise<PolicyRule[]> {
    return this.rules.filter((r) => r.policyVersion === version)
  }
}

export class InMemoryPolicyArticleRepository implements PolicyArticleRepository {
  readonly articles = new Map<string, PolicyArticle>()
  async listByVersion(version: string): Promise<PolicyArticle[]> {
    return [...this.articles.values()]
      .filter((a) => a.policyVersion === version)
      .map((a) => ({ ...a }))
  }
}

export class InMemoryAuditRepository implements AuditRepository {
  readonly entries: AuditLog[] = []
  private nextId = 1
  async append(entry: Omit<AuditLog, 'id'>): Promise<void> {
    this.entries.push({ ...entry, id: this.nextId++ })
  }
  async listByRunId(runId: string): Promise<AuditLog[]> {
    return this.entries.filter((e) => e.runId === runId)
  }
  async listByResource(resourceType: string, resourceId: string): Promise<AuditLog[]> {
    return this.entries.filter(
      (e) => e.resourceType === resourceType && e.resourceId === resourceId,
    )
  }
}

export class InMemoryEventRepository implements EventRepository {
  readonly events: Array<{
    runId: string
    sequence: number
    type: EventType
    payload: unknown
    createdAt: string
  }> = []
  private sequences = new Map<string, number>()
  async append(runId: string, type: EventType, payload: unknown): Promise<number> {
    const sequence = (this.sequences.get(runId) ?? 0) + 1
    this.sequences.set(runId, sequence)
    this.events.push({ runId, sequence, type, payload, createdAt: new Date().toISOString() })
    return sequence
  }
  async listByRun(runId: string, fromSequence = 1) {
    return this.events.filter((e) => e.runId === runId && e.sequence >= fromSequence)
  }
}

export class InMemoryToolExecutionRepository implements ToolExecutionRepository {
  readonly records: ToolExecutionRecord[] = []
  private nextId = 1
  async create(record: Omit<ToolExecutionRecord, 'id'>): Promise<void> {
    this.records.push({ ...record, id: this.nextId++ })
  }
  async listByRunId(runId: string): Promise<ToolExecutionRecord[]> {
    return this.records.filter((r) => r.runId === runId)
  }
  async listAll(): Promise<ToolExecutionRecord[]> {
    return [...this.records]
  }
}

export class InMemoryCheckpointRepository implements CheckpointRepository {
  readonly checkpoints: Checkpoint[] = []
  private nextId = 1
  async save(runId: string, stepId: string, state: Record<string, unknown>): Promise<void> {
    this.checkpoints.push({
      id: this.nextId++,
      runId,
      stepId,
      state,
      createdAt: new Date().toISOString(),
    })
  }
  async latest(runId: string): Promise<Checkpoint | null> {
    const found = this.checkpoints.filter((c) => c.runId === runId)
    return found.length > 0 ? found[found.length - 1]! : null
  }
  async listByRunId(runId: string): Promise<Checkpoint[]> {
    return this.checkpoints.filter((c) => c.runId === runId)
  }
}

export class InMemoryIdempotencyRepository implements IdempotencyRepository {
  readonly records = new Map<string, { key: string; result: Record<string, unknown> }>()
  async find(key: string) {
    return this.records.get(key) ?? null
  }
  async record(key: string, result: Record<string, unknown>): Promise<void> {
    this.records.set(key, { key, result })
  }
}

export class InMemoryAgentRunRepository implements AgentRunRepository {
  readonly runs = new Map<string, AgentRunRecord>()
  async create(record: AgentRunRecord): Promise<void> {
    this.runs.set(record.runId, { ...record })
  }
  async findById(runId: string): Promise<AgentRunRecord | null> {
    const found = this.runs.get(runId)
    return found ? { ...found } : null
  }
  async update(record: AgentRunRecord): Promise<void> {
    this.runs.set(record.runId, { ...record })
  }
  async list(options?: {
    status?: string
    customerId?: string
    limit?: number
  }): Promise<AgentRunRecord[]> {
    let result = [...this.runs.values()]
    if (options?.status) result = result.filter((r) => r.status === options.status)
    if (options?.customerId) result = result.filter((r) => r.customerId === options.customerId)
    result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return result.slice(0, options?.limit ?? 50).map((r) => ({ ...r }))
  }
}

export class InMemoryLeaseRepository implements LeaseRepository {
  private leases = new Map<string, { holder: string; expiresAt: number }>()
  async acquire(
    holder: string,
    resourceType: string,
    resourceId: string,
    ttlMs: number,
  ): Promise<boolean> {
    const key = `${resourceType}:${resourceId}`
    const existing = this.leases.get(key)
    const now = Date.now()
    if (existing && existing.expiresAt > now && existing.holder !== holder) {
      return false
    }
    this.leases.set(key, { holder, expiresAt: now + ttlMs })
    return true
  }
  async release(holder: string, resourceType: string, resourceId: string): Promise<void> {
    const key = `${resourceType}:${resourceId}`
    const existing = this.leases.get(key)
    if (existing && existing.holder === holder) {
      this.leases.delete(key)
    }
  }
}

/** 内存单号生成器 序号从 1 开始 与夹具计数器语义一致 */
export class InMemoryBusinessNoGenerator implements BusinessNoGenerator {
  private counters = new Map<string, number>()
  nextNo(prefix: string): string {
    const year = new Date().getFullYear()
    const key = `${prefix}-${year}`
    const next = (this.counters.get(key) ?? 0) + 1
    this.counters.set(key, next)
    return `${prefix}-${year}-${String(next).padStart(4, '0')}`
  }
}

/** 幂等支付网关内存 mock 相同键只扣款一次 */
export class InMemoryPaymentGateway implements PaymentGatewayPort {
  private charges = new Map<string, { refundNo: string; gatewayRefundId: string }>()
  async withRefund(
    idempotencyKey: string,
    request: { refundNo: string; amountCents: number; currency: string; channel: string },
  ): Promise<{ gatewayRefundId: string }> {
    const existing = this.charges.get(idempotencyKey)
    if (existing) {
      return { gatewayRefundId: existing.gatewayRefundId }
    }
    const gatewayRefundId = `gw_${request.refundNo}`
    this.charges.set(idempotencyKey, { refundNo: request.refundNo, gatewayRefundId })
    return { gatewayRefundId }
  }
  chargeCount(idempotencyKey: string): number {
    return this.charges.has(idempotencyKey) ? 1 : 0
  }
  totalSuccessfulCharges(): number {
    return this.charges.size
  }
}

/** 组装一套完整的内存依赖 */
export function createInMemoryRepositories() {
  return {
    customerRepo: new InMemoryCustomerRepository(),
    orderRepo: new InMemoryOrderRepository(),
    shipmentRepo: new InMemoryShipmentRepository(),
    returnRepo: new InMemoryReturnRepository(),
    refundRepo: new InMemoryRefundRepository(),
    compensationRepo: new InMemoryCompensationRepository(),
    protectionRepo: new InMemoryPriceProtectionRepository(),
    skuPriceRepo: new InMemorySkuPriceRepository(),
    approvalRepo: new InMemoryApprovalRepository(),
    policyRepo: new InMemoryPolicyRepository(),
    policyArticleRepo: new InMemoryPolicyArticleRepository(),
    auditRepo: new InMemoryAuditRepository(),
    eventRepo: new InMemoryEventRepository(),
    toolExecutionRepo: new InMemoryToolExecutionRepository(),
    checkpointRepo: new InMemoryCheckpointRepository(),
    idempotencyRepo: new InMemoryIdempotencyRepository(),
    runRepo: new InMemoryAgentRunRepository(),
    leaseRepo: new InMemoryLeaseRepository(),
    noGenerator: new InMemoryBusinessNoGenerator(),
    gateway: new InMemoryPaymentGateway(),
  }
}

/** 测试用订单构造器 */
export function makeTestOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderNo: 'SO-2026-0001',
    customerId: 'C1001',
    status: 'delivered',
    totalAmountCents: 100_00,
    currency: 'CNY',
    paymentChannel: 'alipay',
    items: [
      {
        itemId: 'item-1',
        sku: 'SKU-001',
        title: '无线耳机',
        category: 'electronics',
        quantity: 1,
        unitPriceCents: 100_00,
      } satisfies OrderItem,
    ],
    paidAt: '2026-09-10T00:00:00.000Z',
    shippedAt: '2026-09-11T00:00:00.000Z',
    deliveredAt: '2026-09-15T00:00:00.000Z',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    version: 1,
    ...overrides,
  }
}
