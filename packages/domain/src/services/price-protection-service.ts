/**
 * 价保领域服务
 *
 * 价保差价的副作用守护层
 * 自签收起 7 天窗口内 降价商品按单价差乘数量全额退还 无上限
 * 支持按 SKU 明细的部分价保 未降价商品不参与计算
 * 同一订单仅可价保一次 拒绝与过期不占位 降价状态变化后允许重新申请
 * 退还复用退款链路的网关与幂等基础设施 价保单与售后单相互独立
 */

import type { Actor, Order, PriceProtection } from '../entities.js'
import { DomainError } from '../repositories.js'
import type {
  BusinessNoGenerator,
  IdempotencyRepository,
  OrderRepository,
  PaymentGatewayPort,
  PriceProtectionRepository,
  ReturnRepository,
  SkuPriceRepository,
} from '../repositories.js'
import type { ApprovalService } from './approval-service.js'
import type { AuditService } from './audit-service.js'
import type { Clock } from '../clock.js'
import { toIso } from '../clock.js'
import { assertPriceProtectionTransition } from '../state-machines.js'
import { decidePriceProtectionPolicy, POLICY_VERSION } from '../policy.js'
import { createToolError, priceProtectionIdempotencyKey } from '@aftersales/contracts'

export interface CreatePriceProtectionInput {
  orderNo: string
  /** 部分价保时指定的商品 为空表示整单 */
  itemIds?: string[]
}

export interface CreatePriceProtectionResult {
  protectionNo: string
  status: PriceProtection['status']
  policyOutcome: 'allow' | 'deny' | 'needs_approval'
  policyExplanation: string
  refundAmountCents: number
  requiresApproval: boolean
  items: PriceProtection['items']
}

export interface ExecutePriceProtectionInput {
  protectionNo: string
  /** 大额路径必传 一次性审批令牌 */
  approvalToken?: string
}

export interface ExecutePriceProtectionResult {
  protectionNo: string
  status: PriceProtection['status']
  amountCents: number
  idempotencyKey: string
  replayed: boolean
}

/** 仍占位的价保状态 同一订单不允许重复发起 拒绝与过期后允许重新申请 */
const OCCUPYING_STATUSES: PriceProtection['status'][] = [
  'created',
  'auto_approved',
  'awaiting_approval',
  'approved',
  'executing',
  'succeeded',
  'failed',
]

/** 进行中的售后状态 订单存在此类售后时不参与价保 */
const ACTIVE_RETURN_STATUSES = new Set([
  'submitted',
  'auto_approved',
  'awaiting_approval',
  'approved',
  'awaiting_buyer_shipment',
  'buyer_shipped',
  'goods_received',
  'failed',
])

export class PriceProtectionService {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly returnRepo: ReturnRepository,
    private readonly protectionRepo: PriceProtectionRepository,
    private readonly skuPriceRepo: SkuPriceRepository,
    private readonly idempotencyRepo: IdempotencyRepository,
    private readonly gateway: PaymentGatewayPort,
    private readonly noGenerator: BusinessNoGenerator,
    private readonly approvals: ApprovalService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** 带乐观锁的保存 本地对象在成功后同步递增版本 */
  private async saveProtection(protection: PriceProtection): Promise<void> {
    await this.protectionRepo.update(protection)
    protection.version += 1
  }

  /** 归属校验 客户只能价保自己的订单 越权拒绝并留审计 */
  private async assertOrderAccess(actor: Actor, order: Order): Promise<void> {
    if (actor.role === 'customer' && order.customerId !== actor.customerId) {
      await this.audit.record(actor, 'order_access_denied', 'order', order.orderNo, {
        orderCustomer: order.customerId,
      })
      throw new DomainError(
        createToolError('AUTHORIZATION_DENIED', '无权访问该订单', {
          resourceType: 'order',
          resourceId: order.orderNo,
        }),
      )
    }
  }

  /**
   * 创建价保单
   *
   * 归属与重复发起先于一切
   * 政策判定纯函数执行 拒赔场景落 rejected 记录并留审计 不占位可重新申请
   * 窗口内降价落 auto_approved 差价达大额阈值落 awaiting_approval
   */
  async createPriceProtection(
    actor: Actor,
    input: CreatePriceProtectionInput,
    runId?: string,
  ): Promise<CreatePriceProtectionResult> {
    const order = await this.orderRepo.findByOrderNo(input.orderNo)
    if (!order) {
      throw new DomainError(
        createToolError('NOT_FOUND', `订单不存在 ${input.orderNo}`, {
          resourceType: 'order',
          resourceId: input.orderNo,
        }),
      )
    }
    await this.assertOrderAccess(actor, order)

    // 指定商品必须属于该订单 防跨单串号
    const wanted = input.itemIds && input.itemIds.length > 0 ? new Set(input.itemIds) : null
    if (wanted) {
      const owned = new Set(order.items.map((item) => item.itemId))
      for (const itemId of wanted) {
        if (!owned.has(itemId)) {
          throw new DomainError(
            createToolError('VALIDATION_ERROR', `商品 ${itemId} 不属于订单 ${input.orderNo}`),
          )
        }
      }
    }

    // 同一订单仅可价保一次 已退还与进行中的都拒绝 拒绝与过期后可重新申请
    const existing = await this.protectionRepo.listByOrderNo(input.orderNo)
    const occupied = existing.find((record) => OCCUPYING_STATUSES.includes(record.status))
    if (occupied) {
      throw new DomainError(
        createToolError('CONFLICT', `该订单已申请过价保 ${occupied.protectionNo} 不能重复申请`, {
          resourceType: 'price_protection',
          resourceId: occupied.protectionNo,
        }),
      )
    }

    // 退货进行中的订单不参与价保 由政策判定输出拒赔解释
    const activeReturn = existingReturnsAreActive(await this.returnRepo.listByOrderNo(input.orderNo))
    const priceLookup = await this.buildPriceLookup(order, wanted)
    const decision = decidePriceProtectionPolicy({
      order,
      itemIds: wanted ? [...wanted] : null,
      priceLookup,
      activeReturn,
      now: this.clock.now(),
    })

    const now = toIso(this.clock.now())
    const record: PriceProtection = {
      protectionNo: this.noGenerator.nextNo('PP'),
      orderNo: input.orderNo,
      customerId: order.customerId,
      status: 'created',
      amountCents: decision.refundAmountCents,
      currency: order.currency,
      // 发放渠道创建时从订单快照 执行时不回查订单
      channel: order.paymentChannel,
      items: decision.items,
      requiresApproval: decision.outcome === 'needs_approval',
      policyRuleId: decision.ruleId,
      policyVersion: POLICY_VERSION,
      createdAt: now,
      updatedAt: now,
      version: 1,
    }
    const targetStatus: PriceProtection['status'] =
      decision.outcome === 'deny'
        ? 'rejected'
        : decision.outcome === 'allow'
          ? 'auto_approved'
          : 'awaiting_approval'
    assertPriceProtectionTransition(record.status, targetStatus)
    record.status = targetStatus
    await this.protectionRepo.create(record)

    await this.audit.record(
      actor,
      decision.outcome === 'deny'
        ? 'price_protection_denied'
        : 'price_protection_created',
      'price_protection',
      record.protectionNo,
      {
        orderNo: input.orderNo,
        itemIds: wanted ? [...wanted] : [],
        refundAmountCents: decision.refundAmountCents,
        requiresApproval: record.requiresApproval,
        policyRule: decision.ruleId,
      },
      runId,
    )

    return {
      protectionNo: record.protectionNo,
      status: record.status,
      policyOutcome: decision.outcome,
      policyExplanation: decision.explanation,
      refundAmountCents: decision.refundAmountCents,
      requiresApproval: record.requiresApproval,
      items: record.items,
    }
  }

  /**
   * 审批决定落地
   *
   * 拒绝或过期时价保单终结 通过时等待执行
   * 幂等 已处理过的决定直接返回当前状态
   */
  async applyApprovalDecision(
    actor: Actor,
    protectionNo: string,
    decision: 'approved' | 'rejected' | 'expired',
    runId?: string,
  ): Promise<PriceProtection> {
    const protection = await this.protectionRepo.findByProtectionNo(protectionNo)
    if (!protection) {
      throw new DomainError(
        createToolError('NOT_FOUND', `价保单不存在 ${protectionNo}`, {
          resourceType: 'price_protection',
          resourceId: protectionNo,
        }),
      )
    }
    if (protection.status !== 'awaiting_approval') {
      return protection
    }
    const targetStatus: PriceProtection['status'] =
      decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'expired'
    assertPriceProtectionTransition(protection.status, targetStatus)
    protection.status = targetStatus
    protection.updatedAt = toIso(this.clock.now())
    await this.saveProtection(protection)

    await this.audit.record(
      actor,
      `price_protection_approval_${decision}`,
      'price_protection',
      protectionNo,
      {},
      runId,
    )
    return protection
  }

  /**
   * 执行价保差价退还
   *
   * 幂等语义与退款执行一致
   * 第一道防线 幂等记录命中直接返回 不触碰网关
   * 第二道防线 网关幂等键 极端情况记录缺失也不会二次退还
   */
  async executePriceProtection(
    actor: Actor,
    input: ExecutePriceProtectionInput,
    runId?: string,
  ): Promise<ExecutePriceProtectionResult> {
    const protection = await this.protectionRepo.findByProtectionNo(input.protectionNo)
    if (!protection) {
      throw new DomainError(
        createToolError('NOT_FOUND', `价保单不存在 ${input.protectionNo}`, {
          resourceType: 'price_protection',
          resourceId: input.protectionNo,
        }),
      )
    }

    const key = priceProtectionIdempotencyKey(input.protectionNo)
    const recorded = await this.idempotencyRepo.find(key)
    if (recorded) {
      return {
        protectionNo: input.protectionNo,
        status: 'succeeded',
        amountCents: protection.amountCents,
        idempotencyKey: key,
        replayed: true,
      }
    }

    // 执行前置状态检查 待审批与拒绝状态不可直接退还
    const executable: PriceProtection['status'][] = ['auto_approved', 'approved', 'failed']
    if (!executable.includes(protection.status)) {
      throw new DomainError(
        createToolError(
          'CONFLICT',
          `价保单当前状态 ${protection.status} 不可执行退还`,
          {
            resourceType: 'price_protection',
            resourceId: input.protectionNo,
          },
        ),
      )
    }

    // 大额路径必须出示有效审批令牌
    if (protection.requiresApproval) {
      const consumed = await this.approvals.consumeToken(
        input.approvalToken ?? '',
        'price_protection',
        input.protectionNo,
      )
      if (!consumed.ok) {
        await this.audit.record(
          actor,
          'price_protection_token_rejected',
          'price_protection',
          input.protectionNo,
          { reason: consumed.error.shape.message },
          runId,
        )
        throw consumed.error
      }
    }

    assertPriceProtectionTransition(protection.status, 'executing')
    protection.status = 'executing'
    protection.updatedAt = toIso(this.clock.now())
    await this.saveProtection(protection)

    try {
      const gatewayResult = await this.gateway.withRefund(key, {
        refundNo: input.protectionNo,
        amountCents: protection.amountCents,
        currency: protection.currency,
        channel: protection.channel,
      })

      // 幂等记录在副作用成功后立即落库 后续重试全部短路
      await this.idempotencyRepo.record(key, {
        protectionNo: input.protectionNo,
        gatewayRefundId: gatewayResult.gatewayRefundId,
        amountCents: protection.amountCents,
      })

      assertPriceProtectionTransition(protection.status, 'succeeded')
      protection.status = 'succeeded'
      protection.updatedAt = toIso(this.clock.now())
      await this.saveProtection(protection)

      await this.audit.record(
        actor,
        'price_protection_executed',
        'price_protection',
        input.protectionNo,
        {
          orderNo: protection.orderNo,
          amountCents: protection.amountCents,
          gatewayRefundId: gatewayResult.gatewayRefundId,
        },
        runId,
      )

      return {
        protectionNo: input.protectionNo,
        status: 'succeeded',
        amountCents: protection.amountCents,
        idempotencyKey: key,
        replayed: false,
      }
    } catch (error) {
      // 网关失败回到可重试状态 重试走同一幂等键
      assertPriceProtectionTransition(protection.status, 'failed')
      protection.status = 'failed'
      protection.updatedAt = toIso(this.clock.now())
      await this.saveProtection(protection)
      throw new DomainError(
        createToolError('UPSTREAM_ERROR', `价保退还失败 ${error instanceof Error ? error.message : String(error)}`, {
          resourceType: 'price_protection',
          resourceId: input.protectionNo,
        }),
      )
    }
  }

  /** 组装当前售价查询 只查询申请涉及的 SKU 无记录的视为未降价 */
  private async buildPriceLookup(
    order: Order,
    wanted: Set<string> | null,
  ): Promise<(sku: string) => number | null> {
    const skus = [
      ...new Set(
        order.items.filter((item) => !wanted || wanted.has(item.itemId)).map((item) => item.sku),
      ),
    ]
    if (skus.length === 0) return () => null
    const prices = await this.skuPriceRepo.listBySkus(skus)
    const bySku = new Map(prices.map((price) => [price.sku, price.currentUnitPriceCents]))
    return (sku: string) => bySku.get(sku) ?? null
  }
}

/** 判断售后单集合中是否存在进行中的售后 */
function existingReturnsAreActive(
  returns: Array<{ status: string }>,
): boolean {
  return returns.some((record) => ACTIVE_RETURN_STATUSES.has(record.status))
}
