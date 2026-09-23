/**
 * 售后领域服务
 *
 * 副作用的核心守护层 所有退款 收货 取消都经由这里
 * 服务负责 归属校验 政策判定 状态迁移 幂等与审计
 * 上层无论是工作流还是运营接口 都绕不开这些不变量
 */

import type { Actor, Order, Refund, ReturnRequest, Shipment } from '../entities.js'
import { DomainError } from '../repositories.js'
import type {
  ApprovalRepository,
  BusinessNoGenerator,
  IdempotencyRepository,
  OrderRepository,
  PaymentGatewayPort,
  RefundRepository,
  ReturnRepository,
  ShipmentRepository,
} from '../repositories.js'
import type { ApprovalService } from './approval-service.js'
import type { AuditService } from './audit-service.js'
import type { Clock } from '../clock.js'
import { toIso } from '../clock.js'
import { assertRefundTransition, assertReturnTransition } from '../state-machines.js'
import { decidePolicy, POLICY_VERSION } from '../policy.js'
import { createToolError, type ReturnReason, type ReturnType } from '@aftersales/contracts'
import { refundIdempotencyKey } from '@aftersales/contracts'

export interface CreateReturnInput {
  orderNo: string
  type: ReturnType
  reason: ReturnReason
  itemIds?: string[]
}

export interface CreateReturnResult {
  returnNo: string
  status: ReturnRequest['status']
  policyOutcome: 'allow' | 'deny' | 'needs_approval'
  policyExplanation: string
  refundNo: string | null
  refundAmountCents: number
  requiresApproval: boolean
}

export interface ExecuteRefundInput {
  returnNo: string
  /** 直连路径必传 一次性审批令牌 */
  approvalToken?: string
  /** 内部联动路径 收货触发退款 令牌从审批记录读取 */
  internal?: boolean
}

export interface ExecuteRefundResult {
  refundNo: string
  status: Refund['status']
  amountCents: number
  idempotencyKey: string
  replayed: boolean
  /** 网关级去重命中 仅在业务幂等记录丢失的崩溃恢复场景出现 */
  gatewayDeduped?: boolean
}

/** 仍处活跃状态的售后单 不允许就同一订单重复发起 */
const ACTIVE_RETURN_STATUSES: ReturnRequest['status'][] = [
  'submitted',
  'auto_approved',
  'awaiting_approval',
  'approved',
  'awaiting_buyer_shipment',
  'buyer_shipped',
  'goods_received',
]

export class AfterSaleService {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly shipmentRepo: ShipmentRepository,
    private readonly returnRepo: ReturnRepository,
    private readonly refundRepo: RefundRepository,
    private readonly approvalRepo: ApprovalRepository,
    private readonly idempotencyRepo: IdempotencyRepository,
    private readonly gateway: PaymentGatewayPort,
    private readonly noGenerator: BusinessNoGenerator,
    private readonly approvals: ApprovalService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * 带乐观锁的保存
   *
   * SQLite 实现按版本号条件更新 本地对象在成功后同步递增版本
   * 保证同一聚合的连续多次更新不会因版本过期而冲突
   */
  private async saveReturn(returnRequest: ReturnRequest): Promise<void> {
    await this.returnRepo.update(returnRequest)
    returnRequest.version += 1
  }

  private async saveRefund(refund: Refund): Promise<void> {
    await this.refundRepo.update(refund)
    refund.version += 1
  }

  /** 归属校验 客户只能访问自己的资源 越权访问拒绝并留审计 */
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

  private async assertReturnAccess(actor: Actor, returnRequest: ReturnRequest): Promise<void> {
    if (actor.role === 'customer' && returnRequest.customerId !== actor.customerId) {
      await this.audit.record(
        actor,
        'return_access_denied',
        'return_request',
        returnRequest.returnNo,
        {},
      )
      throw new DomainError(
        createToolError('AUTHORIZATION_DENIED', '无权访问该售后单', {
          resourceType: 'return_request',
          resourceId: returnRequest.returnNo,
        }),
      )
    }
  }

  /**
   * 创建售后单
   *
   * 政策拒绝不抛错 而是落一条 rejected 记录供解释与审计
   * 归属冲突与重复发起才抛错
   */
  async createReturnRequest(
    actor: Actor,
    input: CreateReturnInput,
    runId?: string,
  ): Promise<CreateReturnResult> {
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

    const existing = await this.returnRepo.listByOrderNo(input.orderNo)
    const active = existing.find((r) => ACTIVE_RETURN_STATUSES.includes(r.status))
    if (active) {
      throw new DomainError(
        createToolError('CONFLICT', `该订单已有进行中的售后单 ${active.returnNo}`, {
          resourceType: 'return_request',
          resourceId: active.returnNo,
        }),
      )
    }
    const refunded = existing.find((r) => r.status === 'completed' && r.type !== 'exchange')
    if (refunded) {
      throw new DomainError(
        createToolError('CONFLICT', `该订单已完成过售后 ${refunded.returnNo} 不能重复申请`, {
          resourceType: 'return_request',
          resourceId: refunded.returnNo,
        }),
      )
    }

    const shipment = await this.shipmentRepo.findByOrderNo(input.orderNo)
    const decision = decidePolicy({
      type: input.type,
      reason: input.reason,
      order,
      shipment,
      itemIds: input.itemIds ?? null,
      clock: this.clock,
    })

    const now = toIso(this.clock.now())
    const returnNo = this.noGenerator.nextNo('RT')
    const record: ReturnRequest = {
      returnNo,
      orderNo: input.orderNo,
      customerId: order.customerId,
      type: input.type,
      reason: input.reason,
      status: 'submitted',
      itemIds: input.itemIds ?? [],
      refundAmountCents: decision.refundAmountCents,
      currency: order.currency,
      policyDecision: {
        outcome: decision.outcome,
        ruleId: decision.ruleId,
        explanation: decision.explanation,
        feeBearer: decision.feeBearer,
      },
      policyVersion: POLICY_VERSION,
      createdAt: now,
      updatedAt: now,
      version: 1,
    }

    // 政策结果决定初始状态 submitted 只是瞬时起点
    const targetStatus: ReturnRequest['status'] =
      decision.outcome === 'allow'
        ? 'auto_approved'
        : decision.outcome === 'needs_approval'
          ? 'awaiting_approval'
          : 'rejected'
    assertReturnTransition(record.status, targetStatus)
    record.status = targetStatus

    // 退货与换货在政策通过后立即进入待寄回状态
    if (decision.outcome === 'allow' && (input.type === 'return' || input.type === 'exchange')) {
      assertReturnTransition(record.status, 'awaiting_buyer_shipment')
      record.status = 'awaiting_buyer_shipment'
    }
    await this.returnRepo.create(record)

    // 退款单预留 换货不产生退款 政策拒绝不预留
    let refundNo: string | null = null
    if (input.type !== 'exchange' && decision.outcome !== 'deny') {
      const refund: Refund = {
        refundNo: this.noGenerator.nextNo('RF'),
        returnNo,
        orderNo: input.orderNo,
        amountCents: decision.refundAmountCents,
        currency: order.currency,
        channel: order.paymentChannel,
        status: 'created',
        idempotencyKey: refundIdempotencyKey(returnNo),
        attempts: 0,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      }
      await this.refundRepo.create(refund)
      refundNo = refund.refundNo
    }

    await this.audit.record(
      actor,
      'return_created',
      'return_request',
      returnNo,
      {
        orderNo: input.orderNo,
        type: input.type,
        reason: input.reason,
        policyOutcome: decision.outcome,
        policyRule: decision.ruleId,
        refundNo,
      },
      runId,
    )

    return {
      returnNo,
      status: record.status,
      policyOutcome: decision.outcome,
      policyExplanation: decision.explanation,
      refundNo,
      refundAmountCents: decision.refundAmountCents,
      requiresApproval: decision.outcome === 'needs_approval',
    }
  }

  /**
   * 审批通过后的状态推进
   *
   * 退货与换货进入待寄回 仅退款保持 approved 等待直接执行
   * 幂等 已处于目标状态时静默返回
   */
  async activateAfterApproval(returnNo: string): Promise<ReturnRequest> {
    const returnRequest = await this.returnRepo.findByReturnNo(returnNo)
    if (!returnRequest) {
      throw new DomainError(
        createToolError('NOT_FOUND', `售后单不存在 ${returnNo}`, {
          resourceType: 'return_request',
          resourceId: returnNo,
        }),
      )
    }
    if (returnRequest.status !== 'approved') {
      return returnRequest
    }
    if (returnRequest.type === 'return' || returnRequest.type === 'exchange') {
      assertReturnTransition(returnRequest.status, 'awaiting_buyer_shipment')
      returnRequest.status = 'awaiting_buyer_shipment'
      returnRequest.updatedAt = toIso(this.clock.now())
      await this.saveReturn(returnRequest)
    }
    return returnRequest
  }

  /**
   * 审批决定落地
   *
   * 拒绝或过期时售后单终结 预留退款单联动取消
   * 通过时推进到下一阶段 退货换货进入待寄回 仅退款等待执行
   */
  async applyApprovalDecision(
    actor: Actor,
    returnNo: string,
    decision: 'approved' | 'rejected' | 'expired',
    runId?: string,
  ): Promise<ReturnRequest> {
    const returnRequest = await this.returnRepo.findByReturnNo(returnNo)
    if (!returnRequest) {
      throw new DomainError(
        createToolError('NOT_FOUND', `售后单不存在 ${returnNo}`, {
          resourceType: 'return_request',
          resourceId: returnNo,
        }),
      )
    }
    if (returnRequest.status !== 'awaiting_approval') {
      // 幂等 已处理过的审批直接返回当前状态
      return returnRequest
    }

    const targetStatus: ReturnRequest['status'] =
      decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'expired'
    assertReturnTransition(returnRequest.status, targetStatus)
    returnRequest.status = targetStatus
    returnRequest.updatedAt = toIso(this.clock.now())
    await this.saveReturn(returnRequest)

    if (decision !== 'approved') {
      const refund = await this.refundRepo.findByReturnNo(returnNo)
      if (refund && refund.status === 'created') {
        assertRefundTransition(refund.status, 'cancelled')
        refund.status = 'cancelled'
        refund.updatedAt = toIso(this.clock.now())
        await this.saveRefund(refund)
      }
    } else if (returnRequest.type === 'return' || returnRequest.type === 'exchange') {
      assertReturnTransition(returnRequest.status, 'awaiting_buyer_shipment')
      returnRequest.status = 'awaiting_buyer_shipment'
      returnRequest.updatedAt = toIso(this.clock.now())
      await this.saveReturn(returnRequest)
    }

    await this.audit.record(actor, `approval_${decision}`, 'return_request', returnNo, {}, runId)
    return returnRequest
  }

  /**
   * 执行退款
   *
   * 幂等语义说明
   * 第一道防线 幂等记录 命中直接返回既有结果 不触碰网关
   * 第二道防线 网关幂等键 极端情况下记录缺失 网关也不会二次扣款
   * 令牌消费失败但退款已成功的场景 属于合法重放 由第一道防线兜住
   */
  async executeRefund(
    actor: Actor,
    input: ExecuteRefundInput,
    runId?: string,
  ): Promise<ExecuteRefundResult> {
    const returnRequest = await this.returnRepo.findByReturnNo(input.returnNo)
    if (!returnRequest) {
      throw new DomainError(
        createToolError('NOT_FOUND', `售后单不存在 ${input.returnNo}`, {
          resourceType: 'return_request',
          resourceId: input.returnNo,
        }),
      )
    }
    await this.assertReturnAccess(actor, returnRequest)

    const refund = await this.refundRepo.findByReturnNo(input.returnNo)
    if (!refund) {
      throw new DomainError(
        createToolError('CONFLICT', `售后单没有关联退款 ${input.returnNo}`, {
          resourceType: 'return_request',
          resourceId: input.returnNo,
        }),
      )
    }

    const key = refundIdempotencyKey(input.returnNo)
    const recorded = await this.idempotencyRepo.find(key)
    if (recorded) {
      // 第一道防线拦截 幂等键命中 重复请求短路返回首次结果 未触碰网关
      await this.audit.record(actor, 'guard_idempotency_replay', 'refund', refund.refundNo, {
        layer: 'idempotency',
        key,
        action: 'execute_refund',
      }, runId)
      return {
        refundNo: refund.refundNo,
        status: 'succeeded',
        amountCents: refund.amountCents,
        idempotencyKey: key,
        replayed: true,
      }
    }

    // 执行前置状态检查
    const executable: ReturnRequest['status'][] = ['auto_approved', 'approved', 'goods_received']
    if (!executable.includes(returnRequest.status)) {
      throw new DomainError(
        createToolError('CONFLICT', `售后单当前状态 ${returnRequest.status} 不可执行退款`, {
          resourceType: 'return_request',
          resourceId: input.returnNo,
        }),
      )
    }

    // 大额或例外路径必须出示有效审批令牌
    if (returnRequest.policyDecision.outcome === 'needs_approval') {
      const token = input.internal
        ? await this.readStoredToken(returnRequest.returnNo)
        : (input.approvalToken ?? '')
      const consumed = await this.approvals.consumeToken(token, 'return_request', input.returnNo)
      if (!consumed.ok) {
        await this.audit.record(
          actor,
          'refund_token_rejected',
          'return_request',
          input.returnNo,
          {
            reason: consumed.error.shape.message,
          },
          runId,
        )
        throw consumed.error
      }
    }

    assertRefundTransition(refund.status, 'executing')
    refund.status = 'executing'
    refund.attempts += 1
    refund.updatedAt = toIso(this.clock.now())
    await this.saveRefund(refund)

    try {
      const gatewayResult = await this.gateway.withRefund(key, {
        refundNo: refund.refundNo,
        amountCents: refund.amountCents,
        currency: refund.currency,
        channel: refund.channel,
      })
      assertRefundTransition(refund.status, 'succeeded')
      refund.status = 'succeeded'
      refund.updatedAt = toIso(this.clock.now())
      await this.saveRefund(refund)

      // 幂等记录在副作用成功后立即落库 后续重试全部短路
      await this.idempotencyRepo.record(key, {
        refundNo: refund.refundNo,
        gatewayRefundId: gatewayResult.gatewayRefundId,
        amountCents: refund.amountCents,
      })

      // 仅退款路径售后单直接完结 退货路径由收货动作推进
      if (returnRequest.status !== 'goods_received' && returnRequest.type === 'refund_only') {
        assertReturnTransition(returnRequest.status, 'completed')
        returnRequest.status = 'completed'
        returnRequest.updatedAt = toIso(this.clock.now())
        await this.saveReturn(returnRequest)
      }

      await this.audit.record(
        actor,
        'refund_executed',
        'refund',
        refund.refundNo,
        {
          returnNo: input.returnNo,
          amountCents: refund.amountCents,
          gatewayRefundId: gatewayResult.gatewayRefundId,
        },
        runId,
      )

      // 第三道防线兜底 业务幂等记录丢失但网关按幂等键去重了 未产生重复扣款
      if (gatewayResult.deduped) {
        await this.audit.record(actor, 'guard_gateway_dedup', 'refund', refund.refundNo, {
          layer: 'gateway',
          key,
          action: 'execute_refund',
        }, runId)
      }
      return {
        refundNo: refund.refundNo,
        status: 'succeeded',
        amountCents: refund.amountCents,
        idempotencyKey: key,
        replayed: false,
        gatewayDeduped: gatewayResult.deduped,
      }
    } catch (error) {
      // 网关失败进入 failed 允许再次执行 重试走同一幂等键
      refund.status = 'failed'
      refund.lastError = error instanceof Error ? error.message : String(error)
      refund.updatedAt = toIso(this.clock.now())
      await this.saveRefund(refund)
      throw new DomainError(
        createToolError('UPSTREAM_ERROR', `退款执行失败 ${refund.lastError}`, {
          resourceType: 'refund',
          resourceId: refund.refundNo,
        }),
      )
    }
  }

  /** 内部路径读取审批记录中的存量令牌 已消费则返回空串由幂等记录兜底 */
  private async readStoredToken(returnNo: string): Promise<string> {
    const approval = await this.approvalRepo.findByResource('return_request', returnNo)
    return approval?.oneTimeToken ?? ''
  }

  /**
   * 买家登记退货物流单号
   */
  async recordReturnShipment(
    actor: Actor,
    returnNo: string,
    trackingNo: string,
    runId?: string,
  ): Promise<ReturnRequest> {
    const returnRequest = await this.returnRepo.findByReturnNo(returnNo)
    if (!returnRequest) {
      throw new DomainError(
        createToolError('NOT_FOUND', `售后单不存在 ${returnNo}`, {
          resourceType: 'return_request',
          resourceId: returnNo,
        }),
      )
    }
    await this.assertReturnAccess(actor, returnRequest)
    if (returnRequest.status === 'buyer_shipped') {
      return returnRequest
    }
    assertReturnTransition(returnRequest.status, 'buyer_shipped')
    returnRequest.status = 'buyer_shipped'
    returnRequest.updatedAt = toIso(this.clock.now())
    await this.saveReturn(returnRequest)
    await this.audit.record(
      actor,
      'return_shipment_recorded',
      'return_request',
      returnNo,
      { trackingNo },
      runId,
    )
    return returnRequest
  }

  /**
   * 卖家确认收到退货 触发退款或换货完结
   *
   * 状态本身就是幂等闸门 重复调用在终态直接返回
   */
  async receiveReturnGoods(
    actor: Actor,
    returnNo: string,
    runId?: string,
  ): Promise<{
    returnNo: string
    status: ReturnRequest['status']
    refundNo: string | null
    refundStatus: Refund['status'] | null
  }> {
    const returnRequest = await this.returnRepo.findByReturnNo(returnNo)
    if (!returnRequest) {
      throw new DomainError(
        createToolError('NOT_FOUND', `售后单不存在 ${returnNo}`, {
          resourceType: 'return_request',
          resourceId: returnNo,
        }),
      )
    }
    await this.assertReturnAccess(actor, returnRequest)

    // 终态直接返回 幂等
    if (returnRequest.status === 'completed') {
      const refund = await this.refundRepo.findByReturnNo(returnNo)
      return {
        returnNo,
        status: 'completed',
        refundNo: refund?.refundNo ?? null,
        refundStatus: refund?.status ?? null,
      }
    }

    // 收货前置状态 必须先有买家寄回动作 严格链路不留跳跃
    const receivable: ReturnRequest['status'][] = ['buyer_shipped']
    if (!receivable.includes(returnRequest.status)) {
      throw new DomainError(
        createToolError('CONFLICT', `售后单当前状态 ${returnRequest.status} 不可确认收货`, {
          resourceType: 'return_request',
          resourceId: returnNo,
        }),
      )
    }

    assertReturnTransition(returnRequest.status, 'goods_received')
    returnRequest.status = 'goods_received'
    returnRequest.updatedAt = toIso(this.clock.now())
    await this.saveReturn(returnRequest)
    await this.audit.record(actor, 'return_goods_received', 'return_request', returnNo, {}, runId)

    // 换货直接完结 重发由仓储执行此处只留痕
    if (returnRequest.type === 'exchange') {
      assertReturnTransition(returnRequest.status, 'completed')
      returnRequest.status = 'completed'
      returnRequest.updatedAt = toIso(this.clock.now())
      await this.saveReturn(returnRequest)
      await this.audit.record(actor, 'exchange_completed', 'return_request', returnNo, {}, runId)
      return { returnNo, status: 'completed', refundNo: null, refundStatus: null }
    }

    // 退货退款 联动执行退款 内部路径 无需外部令牌
    const refundResult = await this.executeRefund(actor, { returnNo, internal: true }, runId)
    assertReturnTransition(returnRequest.status, 'completed')
    returnRequest.status = 'completed'
    returnRequest.updatedAt = toIso(this.clock.now())
    await this.saveReturn(returnRequest)
    return {
      returnNo,
      status: 'completed',
      refundNo: refundResult.refundNo,
      refundStatus: 'succeeded',
    }
  }

  /**
   * 取消售后单
   *
   * 货已在途时不允许线上取消 需人工介入
   */
  async cancelReturnRequest(
    actor: Actor,
    returnNo: string,
    runId?: string,
  ): Promise<ReturnRequest> {
    const returnRequest = await this.returnRepo.findByReturnNo(returnNo)
    if (!returnRequest) {
      throw new DomainError(
        createToolError('NOT_FOUND', `售后单不存在 ${returnNo}`, {
          resourceType: 'return_request',
          resourceId: returnNo,
        }),
      )
    }
    await this.assertReturnAccess(actor, returnRequest)

    const cancellable: ReturnRequest['status'][] = [
      'submitted',
      'auto_approved',
      'awaiting_approval',
      'approved',
      'awaiting_buyer_shipment',
    ]
    if (returnRequest.status === 'cancelled') {
      return returnRequest
    }
    if (!cancellable.includes(returnRequest.status)) {
      throw new DomainError(
        createToolError(
          'CONFLICT',
          `售后单当前状态 ${returnRequest.status} 不可取消 请联系人工客服`,
          {
            resourceType: 'return_request',
            resourceId: returnNo,
          },
        ),
      )
    }

    assertReturnTransition(returnRequest.status, 'cancelled')
    returnRequest.status = 'cancelled'
    returnRequest.updatedAt = toIso(this.clock.now())
    await this.saveReturn(returnRequest)

    const refund = await this.refundRepo.findByReturnNo(returnNo)
    if (refund && refund.status === 'created') {
      assertRefundTransition(refund.status, 'cancelled')
      refund.status = 'cancelled'
      refund.updatedAt = toIso(this.clock.now())
      await this.saveRefund(refund)
    }

    await this.audit.record(actor, 'return_cancelled', 'return_request', returnNo, {}, runId)
    return returnRequest
  }

  /** 查询辅助 供工具层组装输出 */
  async getShipmentForOrder(orderNo: string): Promise<Shipment | null> {
    return this.shipmentRepo.findByOrderNo(orderNo)
  }
}
