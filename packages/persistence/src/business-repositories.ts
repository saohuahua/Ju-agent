/**
 * 业务仓储 SQLite 实现
 *
 * 行映射职责 蛇形列名转驼峰字段 JSON 列编解码
 * 不含业务规则 规则全部在领域服务
 */

import type {
  ApprovalRequest,
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
} from '@aftersales/domain'
import type {
  ApprovalRepository,
  ApprovalDecisionWrite,
  CompensationRepository,
  CustomerRepository,
  OrderRepository,
  PolicyArticleRepository,
  PolicyRepository,
  PriceProtectionRepository,
  RefundRepository,
  ReturnRepository,
  ShipmentRepository,
  SkuPriceRepository,
} from '@aftersales/domain'
import type { PolicyDecisionRecord } from '@aftersales/domain'
import type { OrderItem, ReturnReason, ReturnType } from '@aftersales/contracts'
import type { SqliteDatabase } from './db.js'

interface OrderRow {
  order_no: string
  customer_id: string
  status: string
  total_amount_cents: number
  currency: string
  payment_channel: string
  items_json: string
  paid_at: string | null
  shipped_at: string | null
  delivered_at: string | null
  created_at: string
  updated_at: string
  version: number
}

function rowToOrder(row: OrderRow): Order {
  return {
    orderNo: row.order_no,
    customerId: row.customer_id,
    status: row.status as Order['status'],
    totalAmountCents: row.total_amount_cents,
    currency: row.currency,
    paymentChannel: row.payment_channel,
    items: JSON.parse(row.items_json) as OrderItem[],
    paidAt: row.paid_at,
    shippedAt: row.shipped_at,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  }
}

export class SqliteOrderRepository implements OrderRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async findByOrderNo(orderNo: string): Promise<Order | null> {
    return this.findByOrderNoSync(orderNo)
  }

  /** 同步事务复用原行映射 */
  findByOrderNoSync(orderNo: string): Order | null {
    const row = this.db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo) as
      OrderRow | undefined
    return row ? rowToOrder(row) : null
  }

  async updateVersion(orderNo: string): Promise<void> {
    this.db
      .prepare('UPDATE orders SET version = version + 1, updated_at = ? WHERE order_no = ?')
      .run(new Date().toISOString(), orderNo)
  }
}

export class SqliteShipmentRepository implements ShipmentRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async findByOrderNo(orderNo: string): Promise<Shipment | null> {
    return this.findByOrderNoSync(orderNo)
  }

  /** 同步事务复用原行映射 */
  findByOrderNoSync(orderNo: string): Shipment | null {
    const row = this.db.prepare('SELECT * FROM shipments WHERE order_no = ?').get(orderNo) as
      | {
          shipment_id: string
          order_no: string
          carrier: string
          tracking_no: string
          status: string
          events_json: string
          delivered_at: string | null
          updated_at: string
          version: number
        }
      | undefined
    if (!row) return null
    return {
      shipmentId: row.shipment_id,
      orderNo: row.order_no,
      carrier: row.carrier,
      trackingNo: row.tracking_no,
      status: row.status as Shipment['status'],
      events: JSON.parse(row.events_json) as Shipment['events'],
      deliveredAt: row.delivered_at,
      updatedAt: row.updated_at,
      version: row.version,
    }
  }

  async update(record: Shipment): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE shipments
         SET status = ?, events_json = ?, delivered_at = ?, updated_at = ?, version = version + 1
         WHERE shipment_id = ? AND version = ?`,
      )
      .run(
        record.status,
        JSON.stringify(record.events),
        record.deliveredAt,
        record.updatedAt,
        record.shipmentId,
        record.version,
      )
    if (result.changes === 0) {
      throw new Error(`运单乐观锁冲突 ${record.shipmentId}`)
    }
  }
}

export class SqliteCustomerRepository implements CustomerRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async findById(customerId: string): Promise<Customer | null> {
    const row = this.db.prepare('SELECT * FROM customers WHERE customer_id = ?').get(customerId) as
      { customer_id: string; name: string; phone_masked: string; created_at: string } | undefined
    if (!row) return null
    return {
      customerId: row.customer_id,
      name: row.name,
      phoneMasked: row.phone_masked,
      createdAt: row.created_at,
    }
  }

  async countOrders(customerId: string): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM orders WHERE customer_id = ?')
      .get(customerId) as {
      count: number
    }
    return row.count
  }
}

interface ReturnRow {
  return_no: string
  order_no: string
  customer_id: string
  type: string
  reason: string
  status: string
  item_ids_json: string
  refund_amount_cents: number
  currency: string
  policy_decision_json: string
  policy_version: string
  created_at: string
  updated_at: string
  version: number
}

function rowToReturn(row: ReturnRow): ReturnRequest {
  return {
    returnNo: row.return_no,
    orderNo: row.order_no,
    customerId: row.customer_id,
    type: row.type as ReturnType,
    reason: row.reason as ReturnReason,
    status: row.status as ReturnRequest['status'],
    itemIds: JSON.parse(row.item_ids_json) as string[],
    refundAmountCents: row.refund_amount_cents,
    currency: row.currency,
    policyDecision: JSON.parse(row.policy_decision_json) as PolicyDecisionRecord,
    policyVersion: row.policy_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  }
}

export class SqliteReturnRepository implements ReturnRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async create(record: ReturnRequest): Promise<void> {
    this.createSync(record)
  }

  /** 同步受理不跨异步边界 */
  createSync(record: ReturnRequest): void {
    this.db
      .prepare(
        `INSERT INTO return_requests
         (return_no, order_no, customer_id, type, reason, status, item_ids_json,
          refund_amount_cents, currency, policy_decision_json, policy_version,
          created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.returnNo,
        record.orderNo,
        record.customerId,
        record.type,
        record.reason,
        record.status,
        JSON.stringify(record.itemIds),
        record.refundAmountCents,
        record.currency,
        JSON.stringify(record.policyDecision),
        record.policyVersion,
        record.createdAt,
        record.updatedAt,
        record.version,
      )
  }

  async findByReturnNo(returnNo: string): Promise<ReturnRequest | null> {
    return this.findByReturnNoSync(returnNo)
  }

  /** 同步事务复用原行映射 */
  findByReturnNoSync(returnNo: string): ReturnRequest | null {
    const row = this.db
      .prepare('SELECT * FROM return_requests WHERE return_no = ?')
      .get(returnNo) as ReturnRow | undefined
    return row ? rowToReturn(row) : null
  }

  async listByOrderNo(orderNo: string): Promise<ReturnRequest[]> {
    return this.listByOrderNoSync(orderNo)
  }

  /** 同步事务复用原行映射 */
  listByOrderNoSync(orderNo: string): ReturnRequest[] {
    const rows = this.db
      .prepare('SELECT * FROM return_requests WHERE order_no = ?')
      .all(orderNo) as ReturnRow[]
    return rows.map(rowToReturn)
  }

  async update(record: ReturnRequest): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE return_requests
         SET status = ?, refund_amount_cents = ?, updated_at = ?, version = version + 1
         WHERE return_no = ? AND version = ?`,
      )
      .run(
        record.status,
        record.refundAmountCents,
        record.updatedAt,
        record.returnNo,
        record.version,
      )
    if (result.changes === 0) {
      // 乐观锁冲突 抛错交给上层重读重试
      throw new Error(`售后单乐观锁冲突 ${record.returnNo}`)
    }
  }
}

interface RefundRow {
  refund_no: string
  return_no: string
  order_no: string
  amount_cents: number
  currency: string
  channel: string
  status: string
  idempotency_key: string
  attempts: number
  last_error: string | null
  created_at: string
  updated_at: string
  version: number
}

function rowToRefund(row: RefundRow): Refund {
  return {
    refundNo: row.refund_no,
    returnNo: row.return_no,
    orderNo: row.order_no,
    amountCents: row.amount_cents,
    currency: row.currency,
    channel: row.channel,
    status: row.status as Refund['status'],
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  }
}

export class SqliteRefundRepository implements RefundRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async create(record: Refund): Promise<void> {
    this.createSync(record)
  }

  /** 同步受理不跨异步边界 */
  createSync(record: Refund): void {
    this.db
      .prepare(
        `INSERT INTO refunds
         (refund_no, return_no, order_no, amount_cents, currency, channel, status,
          idempotency_key, attempts, last_error, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.refundNo,
        record.returnNo,
        record.orderNo,
        record.amountCents,
        record.currency,
        record.channel,
        record.status,
        record.idempotencyKey,
        record.attempts,
        record.lastError,
        record.createdAt,
        record.updatedAt,
        record.version,
      )
  }

  async findByRefundNo(refundNo: string): Promise<Refund | null> {
    const row = this.db.prepare('SELECT * FROM refunds WHERE refund_no = ?').get(refundNo) as
      RefundRow | undefined
    return row ? rowToRefund(row) : null
  }

  async findByReturnNo(returnNo: string): Promise<Refund | null> {
    return this.findByReturnNoSync(returnNo)
  }

  /** 同步事务复用原行映射 */
  findByReturnNoSync(returnNo: string): Refund | null {
    const row = this.db.prepare('SELECT * FROM refunds WHERE return_no = ?').get(returnNo) as
      RefundRow | undefined
    return row ? rowToRefund(row) : null
  }

  async update(record: Refund): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE refunds
         SET status = ?, attempts = ?, last_error = ?, updated_at = ?, version = version + 1
         WHERE refund_no = ? AND version = ?`,
      )
      .run(
        record.status,
        record.attempts,
        record.lastError,
        record.updatedAt,
        record.refundNo,
        record.version,
      )
    if (result.changes === 0) {
      throw new Error(`退款单乐观锁冲突 ${record.refundNo}`)
    }
  }
}

interface CompensationRow {
  compensation_no: string
  order_no: string
  customer_id: string
  reason: string
  status: string
  amount_cents: number
  currency: string
  channel: string
  requires_approval: number
  policy_version: string
  created_at: string
  updated_at: string
  version: number
}

function rowToCompensation(row: CompensationRow): Compensation {
  return {
    compensationNo: row.compensation_no,
    orderNo: row.order_no,
    customerId: row.customer_id,
    reason: row.reason as Compensation['reason'],
    status: row.status as Compensation['status'],
    amountCents: row.amount_cents,
    currency: row.currency,
    channel: row.channel,
    requiresApproval: row.requires_approval === 1,
    policyVersion: row.policy_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  }
}

export class SqliteCompensationRepository implements CompensationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async create(record: Compensation): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO compensations
         (compensation_no, order_no, customer_id, reason, status, amount_cents, currency,
          channel, requires_approval, policy_version, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.compensationNo,
        record.orderNo,
        record.customerId,
        record.reason,
        record.status,
        record.amountCents,
        record.currency,
        record.channel,
        record.requiresApproval ? 1 : 0,
        record.policyVersion,
        record.createdAt,
        record.updatedAt,
        record.version,
      )
  }

  async findByCompensationNo(compensationNo: string): Promise<Compensation | null> {
    const row = this.db
      .prepare('SELECT * FROM compensations WHERE compensation_no = ?')
      .get(compensationNo) as CompensationRow | undefined
    return row ? rowToCompensation(row) : null
  }

  async listByOrderNo(orderNo: string): Promise<Compensation[]> {
    const rows = this.db
      .prepare('SELECT * FROM compensations WHERE order_no = ?')
      .all(orderNo) as CompensationRow[]
    return rows.map(rowToCompensation)
  }

  async update(record: Compensation): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE compensations
         SET status = ?, updated_at = ?, version = version + 1
         WHERE compensation_no = ? AND version = ?`,
      )
      .run(record.status, record.updatedAt, record.compensationNo, record.version)
    if (result.changes === 0) {
      throw new Error(`补偿单乐观锁冲突 ${record.compensationNo}`)
    }
  }
}

interface PriceProtectionRow {
  protection_no: string
  order_no: string
  customer_id: string
  status: string
  amount_cents: number
  currency: string
  channel: string
  items_json: string
  requires_approval: number
  policy_rule_id: string
  policy_version: string
  created_at: string
  updated_at: string
  version: number
}

function rowToPriceProtection(row: PriceProtectionRow): PriceProtection {
  return {
    protectionNo: row.protection_no,
    orderNo: row.order_no,
    customerId: row.customer_id,
    status: row.status as PriceProtection['status'],
    amountCents: row.amount_cents,
    currency: row.currency,
    channel: row.channel,
    items: JSON.parse(row.items_json) as PriceProtection['items'],
    requiresApproval: row.requires_approval === 1,
    policyRuleId: row.policy_rule_id,
    policyVersion: row.policy_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  }
}

export class SqlitePriceProtectionRepository implements PriceProtectionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async create(record: PriceProtection): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO price_protections
         (protection_no, order_no, customer_id, status, amount_cents, currency, channel,
          items_json, requires_approval, policy_rule_id, policy_version, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.protectionNo,
        record.orderNo,
        record.customerId,
        record.status,
        record.amountCents,
        record.currency,
        record.channel,
        JSON.stringify(record.items),
        record.requiresApproval ? 1 : 0,
        record.policyRuleId,
        record.policyVersion,
        record.createdAt,
        record.updatedAt,
        record.version,
      )
  }

  async findByProtectionNo(protectionNo: string): Promise<PriceProtection | null> {
    const row = this.db
      .prepare('SELECT * FROM price_protections WHERE protection_no = ?')
      .get(protectionNo) as PriceProtectionRow | undefined
    return row ? rowToPriceProtection(row) : null
  }

  async listByOrderNo(orderNo: string): Promise<PriceProtection[]> {
    const rows = this.db
      .prepare('SELECT * FROM price_protections WHERE order_no = ?')
      .all(orderNo) as PriceProtectionRow[]
    return rows.map(rowToPriceProtection)
  }

  async update(record: PriceProtection): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE price_protections
         SET status = ?, updated_at = ?, version = version + 1
         WHERE protection_no = ? AND version = ?`,
      )
      .run(record.status, record.updatedAt, record.protectionNo, record.version)
    if (result.changes === 0) {
      throw new Error(`价保单乐观锁冲突 ${record.protectionNo}`)
    }
  }
}

interface SkuPriceRow {
  sku: string
  current_unit_price_cents: number
  updated_at: string
}

/** 商品当前售价仓储 只读 数据由运营端维护 这里只提供查询 */
export class SqliteSkuPriceRepository implements SkuPriceRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async listBySkus(skus: string[]): Promise<SkuPrice[]> {
    if (skus.length === 0) return []
    const placeholders = skus.map(() => '?').join(', ')
    const rows = this.db
      .prepare(`SELECT * FROM sku_prices WHERE sku IN (${placeholders})`)
      .all(...skus) as SkuPriceRow[]
    return rows.map((row) => ({
      sku: row.sku,
      currentUnitPriceCents: row.current_unit_price_cents,
      updatedAt: row.updated_at,
    }))
  }
}

interface PolicyArticleRow {
  article_id: string
  policy_version: string
  title: string
  content: string
  source: string
  created_at: string
}

/** 政策语料条款仓储 只读 语料随政策版本由夹具载入 */
export class SqlitePolicyArticleRepository implements PolicyArticleRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async listByVersion(version: string): Promise<PolicyArticle[]> {
    const rows = this.db
      .prepare('SELECT * FROM policy_articles WHERE policy_version = ?')
      .all(version) as PolicyArticleRow[]
    return rows.map((row) => ({
      articleId: row.article_id,
      policyVersion: row.policy_version,
      title: row.title,
      content: row.content,
      source: row.source,
      createdAt: row.created_at,
    }))
  }
}

export class SqliteApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private rowToApproval(row: Record<string, unknown>): ApprovalRequest {
    return {
      approvalId: row.approval_id as string,
      runId: (row.run_id as string | null) ?? null,
      resourceType: row.resource_type as string,
      resourceId: row.resource_id as string,
      reason: row.reason as string,
      amountCents: row.amount_cents as number,
      status: row.status as ApprovalRequest['status'],
      oneTimeToken: row.one_time_token as string,
      requestedBy: row.requested_by as string,
      decidedBy: (row.decided_by as string | null) ?? null,
      decidedAt: (row.decided_at as string | null) ?? null,
      expiresAt: row.expires_at as string,
      createdAt: row.created_at as string,
    }
  }

  async create(record: ApprovalRequest): Promise<void> {
    this.createSync(record)
  }

  /** 审批与原方案在同一受理事务保存 */
  createSync(record: ApprovalRequest): void {
    this.db
      .prepare(
        `INSERT INTO approval_requests
         (approval_id, run_id, resource_type, resource_id, reason, amount_cents, status,
          one_time_token, requested_by, decided_by, decided_at, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.approvalId,
        record.runId,
        record.resourceType,
        record.resourceId,
        record.reason,
        record.amountCents,
        record.status,
        record.oneTimeToken,
        record.requestedBy,
        record.decidedBy,
        record.decidedAt,
        record.expiresAt,
        record.createdAt,
      )
  }

  async findById(approvalId: string): Promise<ApprovalRequest | null> {
    const row = this.db
      .prepare('SELECT * FROM approval_requests WHERE approval_id = ?')
      .get(approvalId) as Record<string, unknown> | undefined
    return row ? this.rowToApproval(row) : null
  }

  async findByResource(resourceType: string, resourceId: string): Promise<ApprovalRequest | null> {
    const row = this.db
      .prepare('SELECT * FROM approval_requests WHERE resource_type = ? AND resource_id = ?')
      .get(resourceType, resourceId) as Record<string, unknown> | undefined
    return row ? this.rowToApproval(row) : null
  }

  async listPending(): Promise<ApprovalRequest[]> {
    const rows = this.db.prepare('SELECT * FROM approval_requests WHERE status = ?').all('pending')
    return rows.map((row) => this.rowToApproval(row as Record<string, unknown>))
  }

  /** 决定与执行意图同步提交 任一步失败都会回滚整个事务 */
  async decidePending(input: ApprovalDecisionWrite): Promise<ApprovalRequest | null> {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `UPDATE approval_requests
        SET status = ?, decided_by = ?, decided_at = ?
        WHERE approval_id = ? AND status = 'pending' AND expires_at > ?
        ${
          input.runId
            ? `AND run_id = ? AND EXISTS (
          SELECT 1 FROM agent_runs WHERE run_id = ? AND status = 'awaiting_approval'
        )`
            : ''
        }
        ${input.checkpointId !== undefined ? 'AND (SELECT MAX(id) FROM checkpoints WHERE run_id = approval_requests.run_id) = ?' : ''}
        RETURNING *`,
        )
        .get(
          input.decision,
          input.decidedBy,
          input.now,
          input.approvalId,
          input.now,
          ...(input.runId ? [input.runId, input.runId] : []),
          ...(input.checkpointId !== undefined ? [input.checkpointId] : []),
        ) as Record<string, unknown> | undefined

      if (!row) return null
      if (input.runId) {
        this.db
          .prepare(
            `INSERT INTO approval_execution_intents
          (approval_id, run_id, decision, decided_by, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(input.approvalId, input.runId, input.decision, input.decidedBy, input.now, input.now)
      }
      return this.rowToApproval(row)
    })()
  }

  /** 单条条件更新消费令牌 空字符串永远不是有效凭据 */
  async consumeToken(
    approvalId: string,
    token: string,
    resourceType: string,
    resourceId: string,
    now: string,
  ): Promise<boolean> {
    if (!token) return false
    const result = this.db
      .prepare(
        `UPDATE approval_requests SET one_time_token = ''
      WHERE approval_id = ? AND resource_type = ? AND resource_id = ?
        AND status = 'approved' AND one_time_token = ? AND one_time_token <> '' AND expires_at > ?`,
      )
      .run(approvalId, resourceType, resourceId, token, now)
    return result.changes === 1
  }
}

export class SqlitePolicyRepository implements PolicyRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async listRules(version: string): Promise<PolicyRule[]> {
    const rows = this.db
      .prepare('SELECT * FROM policies WHERE policy_version = ? ORDER BY rule_id')
      .all(version) as Array<{
      rule_id: string
      policy_version: string
      description: string
      time_window_days: number | null
      excluded_categories_json: string | null
    }>
    return rows.map((row) => ({
      ruleId: row.rule_id,
      policyVersion: row.policy_version,
      description: row.description,
      timeWindowDays: row.time_window_days,
      excludedCategories: row.excluded_categories_json
        ? (JSON.parse(row.excluded_categories_json) as string[])
        : null,
    }))
  }
}
