/**
 * 补偿领域服务
 *
 * 现金红包安抚的副作用守护层
 * 分级规则 自动发放阈值内直接执行 以上必须人工审批
 * 不可叠加 同一订单同一原因仅一次 重复请求幂等拒绝
 * 发放复用退款链路的网关与幂等基础设施 补偿单与售后单相互独立
 */

import type { Actor, Compensation, Order } from '../entities.js'
import { DomainError } from '../repositories.js'
import type {
  BusinessNoGenerator,
  CompensationRepository,
  IdempotencyRepository,
  OrderRepository,
  PaymentGatewayPort,
} from '../repositories.js'
import type { ApprovalService } from './approval-service.js'
import type { AuditService } from './audit-service.js'
import type { Clock } from '../clock.js'
import { toIso } from '../clock.js'
import { assertCompensationTransition } from '../state-machines.js'
import { evaluateCompensationPolicy, POLICY_VERSION } from '../policy.js'
import { compensationIdempotencyKey, createToolError } from '@aftersales/contracts'
import type { CompensationReason } from '@aftersales/contracts'

export interface CreateCompensationInput {
  orderNo: string
  reason: CompensationReason
  amountCents: number
}

export interface CreateCompensationResult {
  compensationNo: string
  status: Compensation['status']
  requiresApproval: boolean
  policyExplanation: string
  amountCents: number
}

export interface ExecuteCompensationInput {
  compensationNo: string
  /** 大额路径必传 一次性审批令牌 */
  approvalToken?: string
}

export interface ExecuteCompensationResult {
  compensationNo: string
  status: Compensation['status']
  amountCents: number
  idempotencyKey: string
  replayed: boolean
}

/** 仍占位的补偿状态 同订单同原因不允许重复发起 */
const OCCUPYING_STATUSES: Compensation['status'][] = [
  'created',
  'auto_approved',
  'awaiting_approval',
  'approved',
  'executing',
  'succeeded',
  'failed',
]

export class CompensationService {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly compensationRepo: CompensationRepository,
    private readonly idempotencyRepo: IdempotencyRepository,
    private readonly gateway: PaymentGatewayPort,
    private readonly noGenerator: BusinessNoGenerator,
    private readonly approvals: ApprovalService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** 带乐观锁的保存 本地对象在成功后同步递增版本 */
  private async saveCompensation(compensation: Compensation): Promise<void> {
    await this.compensationRepo.update(compensation)
    compensation.version += 1
  }

  /** 归属校验 客户只能补偿自己的订单 越权拒绝并留审计 */
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
   * 创建补偿单
   *
   * 金额有效性 归属与重复发起先于一切
   * 分级判定纯函数执行 阈值内落 auto_approved 以上落 awaiting_approval
   */
  async createCompensation(
    actor: Actor,
    input: CreateCompensationInput,
    runId?: string,
  ): Promise<CreateCompensationResult> {
    if (input.amountCents <= 0) {
      throw new DomainError(createToolError('VALIDATION_ERROR', '补偿金额必须大于 0'))
    }
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

    // 不可叠加 同一订单同一原因仅一次 已发放与进行中的都拒绝
    const existing = await this.compensationRepo.listByOrderNo(input.orderNo)
    const occupied = existing.find(
      (record) => record.reason === input.reason && OCCUPYING_STATUSES.includes(record.status),
    )
    if (occupied) {
      throw new DomainError(
        createToolError('CONFLICT', `该订单已就同一原因补偿过 ${occupied.compensationNo} 不能重复发放`, {
          resourceType: 'compensation',
          resourceId: occupied.compensationNo,
        }),
      )
    }

    const decision = evaluateCompensationPolicy({ amountCents: input.amountCents })
    const now = toIso(this.clock.now())
    const record: Compensation = {
      compensationNo: this.noGenerator.nextNo('CP'),
      orderNo: input.orderNo,
      customerId: order.customerId,
      reason: input.reason,
      status: 'created',
      amountCents: input.amountCents,
      currency: order.currency,
      // 发放渠道创建时从订单快照 与退款单同构 执行时不回查订单
      channel: order.paymentChannel,
      requiresApproval: decision.outcome === 'needs_approval',
      policyVersion: POLICY_VERSION,
      createdAt: now,
      updatedAt: now,
      version: 1,
    }
    const targetStatus: Compensation['status'] =
      decision.outcome === 'allow' ? 'auto_approved' : 'awaiting_approval'
    assertCompensationTransition(record.status, targetStatus)
    record.status = targetStatus
    await this.compensationRepo.create(record)

    await this.audit.record(
      actor,
      'compensation_created',
      'compensation',
      record.compensationNo,
      {
        orderNo: input.orderNo,
        reason: input.reason,
        amountCents: input.amountCents,
        requiresApproval: record.requiresApproval,
        policyRule: decision.ruleId,
      },
      runId,
    )

    return {
      compensationNo: record.compensationNo,
      status: record.status,
      requiresApproval: record.requiresApproval,
      policyExplanation: decision.explanation,
      amountCents: record.amountCents,
    }
  }

  /**
   * 审批决定落地
   *
   * 拒绝或过期时补偿单终结 通过时等待执行
   * 幂等 已处理过的决定直接返回当前状态
   */
  async applyApprovalDecision(
    actor: Actor,
    compensationNo: string,
    decision: 'approved' | 'rejected' | 'expired',
    runId?: string,
  ): Promise<Compensation> {
    const compensation = await this.compensationRepo.findByCompensationNo(compensationNo)
    if (!compensation) {
      throw new DomainError(
        createToolError('NOT_FOUND', `补偿单不存在 ${compensationNo}`, {
          resourceType: 'compensation',
          resourceId: compensationNo,
        }),
      )
    }
    if (compensation.status !== 'awaiting_approval') {
      return compensation
    }
    const targetStatus: Compensation['status'] =
      decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'expired'
    assertCompensationTransition(compensation.status, targetStatus)
    compensation.status = targetStatus
    compensation.updatedAt = toIso(this.clock.now())
    await this.saveCompensation(compensation)

    await this.audit.record(
      actor,
      `compensation_approval_${decision}`,
      'compensation',
      compensationNo,
      {},
      runId,
    )
    return compensation
  }

  /**
   * 执行现金红包发放
   *
   * 幂等语义与退款执行一致
   * 第一道防线 幂等记录命中直接返回 不触碰网关
   * 第二道防线 网关幂等键 极端情况记录缺失也不会二次发放
   */
  async executeCompensation(
    actor: Actor,
    input: ExecuteCompensationInput,
    runId?: string,
  ): Promise<ExecuteCompensationResult> {
    const compensation = await this.compensationRepo.findByCompensationNo(input.compensationNo)
    if (!compensation) {
      throw new DomainError(
        createToolError('NOT_FOUND', `补偿单不存在 ${input.compensationNo}`, {
          resourceType: 'compensation',
          resourceId: input.compensationNo,
        }),
      )
    }

    const key = compensationIdempotencyKey(input.compensationNo)
    const recorded = await this.idempotencyRepo.find(key)
    if (recorded) {
      return {
        compensationNo: input.compensationNo,
        status: 'succeeded',
        amountCents: compensation.amountCents,
        idempotencyKey: key,
        replayed: true,
      }
    }

    // 执行前置状态检查 待审批状态不可直接发放
    const executable: Compensation['status'][] = ['auto_approved', 'approved', 'failed']
    if (!executable.includes(compensation.status)) {
      throw new DomainError(
        createToolError(
          'CONFLICT',
          `补偿单当前状态 ${compensation.status} 不可执行发放`,
          {
            resourceType: 'compensation',
            resourceId: input.compensationNo,
          },
        ),
      )
    }

    // 大额路径必须出示有效审批令牌
    if (compensation.requiresApproval) {
      const consumed = await this.approvals.consumeToken(
        input.approvalToken ?? '',
        'compensation',
        input.compensationNo,
      )
      if (!consumed.ok) {
        await this.audit.record(
          actor,
          'compensation_token_rejected',
          'compensation',
          input.compensationNo,
          { reason: consumed.error.shape.message },
          runId,
        )
        throw consumed.error
      }
    }

    assertCompensationTransition(compensation.status, 'executing')
    compensation.status = 'executing'
    compensation.updatedAt = toIso(this.clock.now())
    await this.saveCompensation(compensation)

    try {
      const gatewayResult = await this.gateway.withRefund(key, {
        refundNo: input.compensationNo,
        amountCents: compensation.amountCents,
        currency: compensation.currency,
        channel: compensation.channel,
      })

      // 幂等记录在副作用成功后立即落库 后续重试全部短路
      await this.idempotencyRepo.record(key, {
        compensationNo: input.compensationNo,
        gatewayRefundId: gatewayResult.gatewayRefundId,
        amountCents: compensation.amountCents,
      })

      assertCompensationTransition(compensation.status, 'succeeded')
      compensation.status = 'succeeded'
      compensation.updatedAt = toIso(this.clock.now())
      await this.saveCompensation(compensation)

      await this.audit.record(
        actor,
        'compensation_executed',
        'compensation',
        input.compensationNo,
        {
          orderNo: compensation.orderNo,
          amountCents: compensation.amountCents,
          gatewayRefundId: gatewayResult.gatewayRefundId,
        },
        runId,
      )

      return {
        compensationNo: input.compensationNo,
        status: 'succeeded',
        amountCents: compensation.amountCents,
        idempotencyKey: key,
        replayed: false,
      }
    } catch (error) {
      // 网关失败回到可重试状态 重试走同一幂等键
      assertCompensationTransition(compensation.status, 'failed')
      compensation.status = 'failed'
      compensation.updatedAt = toIso(this.clock.now())
      await this.saveCompensation(compensation)
      throw new DomainError(
        createToolError('UPSTREAM_ERROR', `补偿发放失败 ${error instanceof Error ? error.message : String(error)}`, {
          resourceType: 'compensation',
          resourceId: input.compensationNo,
        }),
      )
    }
  }
}