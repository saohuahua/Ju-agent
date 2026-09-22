/**
 * 工具定义与注册工厂
 *
 * 每个工具是薄适配层 参数校验与轨迹由执行器统一处理
 * 这里只做 组装领域调用 归属校验 输出裁剪
 */

import { POLICY_VERSION } from '@aftersales/domain'
import { DomainError } from '@aftersales/domain'
import type {
  AfterSaleService,
  AuditService,
  CompensationService,
  CustomerRepository,
  OrderRepository,
  PolicyRepository,
  PolicySearchService,
  PriceProtectionService,
  RefundRepository,
  ReturnRepository,
  ShipmentRepository,
} from '@aftersales/domain'
import { createToolError } from '@aftersales/contracts'
import type { ToolInput, ToolName, ToolOutput } from '@aftersales/contracts'
import type { ToolContext } from './registry.js'
import { ToolRegistry } from './registry.js'

export interface ToolDependencies {
  customerRepo: CustomerRepository
  orderRepo: OrderRepository
  shipmentRepo: ShipmentRepository
  policyRepo: PolicyRepository
  returnRepo: ReturnRepository
  refundRepo: RefundRepository
  afterSaleService: AfterSaleService
  compensationService: CompensationService
  priceProtectionService: PriceProtectionService
  policySearchService: PolicySearchService
  auditService: AuditService
}

/** 客户身份只能查自己 操作员可查任意客户 */
function assertCustomerLookupAllowed(context: ToolContext, customerId: string): void {
  if (context.actor.role === 'customer' && context.actor.customerId !== customerId) {
    throw new DomainError(createToolError('AUTHORIZATION_DENIED', '只能查询本人信息'))
  }
}

/** 查询他人订单前先经归属校验 拒绝必须留审计 */
async function assertOrderOwnership(
  context: ToolContext,
  orderCustomerId: string,
  orderNo: string,
  auditService: AuditService,
): Promise<void> {
  if (context.actor.role === 'customer' && context.actor.customerId !== orderCustomerId) {
    await auditService.record(
      context.actor,
      'order_access_denied',
      'order',
      orderNo,
      {},
      context.runId ?? undefined,
    )
    throw new DomainError(
      createToolError('AUTHORIZATION_DENIED', '无权访问该订单', {
        resourceType: 'order',
        resourceId: orderNo,
      }),
    )
  }
}

export function buildToolRegistry(deps: ToolDependencies): ToolRegistry {
  const registry = new ToolRegistry()

  registry.register('lookup_customer', async (input: ToolInput<'lookup_customer'>, context) => {
    assertCustomerLookupAllowed(context, input.customerId)
    const customer = await deps.customerRepo.findById(input.customerId)
    if (!customer) {
      throw new DomainError(createToolError('NOT_FOUND', `客户不存在 ${input.customerId}`))
    }
    const orderCount = await deps.customerRepo.countOrders(input.customerId)
    return {
      customerId: customer.customerId,
      name: customer.name,
      phoneMasked: customer.phoneMasked,
      orderCount,
    }
  })

  registry.register('get_order', async (input: ToolInput<'get_order'>, context) => {
    const order = await deps.orderRepo.findByOrderNo(input.orderNo)
    if (!order) {
      throw new DomainError(
        createToolError('NOT_FOUND', `订单不存在 ${input.orderNo}`, {
          resourceType: 'order',
          resourceId: input.orderNo,
        }),
      )
    }
    await assertOrderOwnership(context, order.customerId, order.orderNo, deps.auditService)
    await deps.auditService.record(
      context.actor,
      'order_queried',
      'order',
      order.orderNo,
      {},
      context.runId ?? undefined,
    )
    // 售后历史随单返回 重复申请与已退款订单的判定依据 模型据此如实答复
    const returns = await deps.returnRepo.listByOrderNo(order.orderNo)
    const history = await Promise.all(
      returns.map(async (record) => {
        const refund = await deps.refundRepo.findByReturnNo(record.returnNo)
        return {
          returnNo: record.returnNo,
          type: record.type,
          reason: record.reason,
          status: record.status,
          refundStatus: refund?.status ?? null,
          refundAmountCents: refund?.amountCents ?? null,
        }
      }),
    )
    return {
      orderNo: order.orderNo,
      customerId: order.customerId,
      status: order.status,
      totalAmountCents: order.totalAmountCents,
      currency: order.currency,
      paymentChannel: order.paymentChannel,
      items: order.items,
      paidAt: order.paidAt,
      deliveredAt: order.deliveredAt,
      createdAt: order.createdAt,
      returns: history,
    }
  })

  registry.register('get_shipment', async (input: ToolInput<'get_shipment'>, context) => {
    const order = await deps.orderRepo.findByOrderNo(input.orderNo)
    if (!order) {
      throw new DomainError(
        createToolError('NOT_FOUND', `订单不存在 ${input.orderNo}`, {
          resourceType: 'order',
          resourceId: input.orderNo,
        }),
      )
    }
    await assertOrderOwnership(context, order.customerId, order.orderNo, deps.auditService)
    const shipment = await deps.shipmentRepo.findByOrderNo(input.orderNo)
    if (!shipment) {
      throw new DomainError(
        createToolError('NOT_FOUND', `订单没有物流记录 ${input.orderNo}`, {
          resourceType: 'order',
          resourceId: input.orderNo,
        }),
      )
    }
    await deps.auditService.record(
      context.actor,
      'shipment_queried',
      'shipment',
      shipment.shipmentId,
      {},
      context.runId ?? undefined,
    )
    return {
      orderNo: shipment.orderNo,
      carrier: shipment.carrier,
      trackingNo: shipment.trackingNo,
      status: shipment.status,
      events: shipment.events,
      deliveredAt: shipment.deliveredAt,
    }
  })

  registry.register(
    'get_policy',
    async (input: ToolInput<'get_policy'>): Promise<ToolOutput<'get_policy'>> => {
      const rules = await deps.policyRepo.listRules(POLICY_VERSION)
      const filtered = input.topic
        ? rules.filter(
            (rule) =>
              rule.description.includes(input.topic as string) ||
              rule.ruleId.includes(input.topic as string),
          )
        : rules
      return {
        policyVersion: POLICY_VERSION,
        rules: filtered.map((rule) => ({
          ruleId: rule.ruleId,
          description: rule.description,
          timeWindowDays: rule.timeWindowDays,
          excludedCategories: rule.excludedCategories,
        })),
      }
    },
  )

  registry.register(
    'search_policy',
    async (input: ToolInput<'search_policy'>, context) => {
      const result = await deps.policySearchService.search(
        context.actor,
        input.query,
        input.limit,
        context.runId ?? undefined,
      )
      return {
        articles: result.articles.map((article) => ({
          articleId: article.articleId,
          title: article.title,
          content: article.content,
          score: article.score,
          reason: article.reason,
        })),
        count: result.count,
      }
    },
  )

  registry.register(
    'create_return_request',
    async (input: ToolInput<'create_return_request'>, context) => {
      const result = await deps.afterSaleService.createReturnRequest(
        context.actor,
        {
          orderNo: input.orderNo,
          type: input.type,
          reason: input.reason,
          itemIds: input.itemIds,
        },
        context.runId ?? undefined,
      )
      return {
        returnNo: result.returnNo,
        status: result.status,
        policyOutcome: result.policyOutcome,
        policyExplanation: result.policyExplanation,
        refundNo: result.refundNo,
        refundAmountCents: result.refundAmountCents,
        requiresApproval: result.requiresApproval,
      }
    },
  )

  registry.register(
    'record_return_shipment',
    async (input: ToolInput<'record_return_shipment'>, context) => {
      const result = await deps.afterSaleService.recordReturnShipment(
        context.actor,
        input.returnNo,
        input.trackingNo,
        context.runId ?? undefined,
      )
      return { returnNo: result.returnNo, status: result.status }
    },
  )

  registry.register(
    'receive_return_goods',
    async (input: ToolInput<'receive_return_goods'>, context) => {
      // 运营工具 只允许操作员与主管触发
      if (context.actor.role === 'customer') {
        throw new DomainError(createToolError('AUTHORIZATION_DENIED', '确认收货仅限售后专员操作'))
      }
      const result = await deps.afterSaleService.receiveReturnGoods(
        context.actor,
        input.returnNo,
        context.runId ?? undefined,
      )
      return {
        returnNo: result.returnNo,
        status: result.status,
        refundNo: result.refundNo,
        refundStatus: result.refundStatus,
      }
    },
  )

  registry.register('execute_refund', async (input: ToolInput<'execute_refund'>, context) => {
    const result = await deps.afterSaleService.executeRefund(
      context.actor,
      { returnNo: input.returnNo, approvalToken: input.approvalToken },
      context.runId ?? undefined,
    )
    return {
      refundNo: result.refundNo,
      status: result.status,
      amountCents: result.amountCents,
      idempotencyKey: result.idempotencyKey,
    }
  })

  registry.register(
    'cancel_return_request',
    async (input: ToolInput<'cancel_return_request'>, context) => {
      const result = await deps.afterSaleService.cancelReturnRequest(
        context.actor,
        input.returnNo,
        context.runId ?? undefined,
      )
      return { returnNo: result.returnNo, status: result.status }
    },
  )

  registry.register(
    'create_compensation',
    async (input: ToolInput<'create_compensation'>, context) => {
      const result = await deps.compensationService.createCompensation(
        context.actor,
        {
          orderNo: input.orderNo,
          reason: input.reason,
          amountCents: input.amountCents,
        },
        context.runId ?? undefined,
      )
      return {
        compensationNo: result.compensationNo,
        status: result.status,
        requiresApproval: result.requiresApproval,
        policyExplanation: result.policyExplanation,
        amountCents: result.amountCents,
      }
    },
  )

  registry.register(
    'execute_compensation',
    async (input: ToolInput<'execute_compensation'>, context) => {
      const result = await deps.compensationService.executeCompensation(
        context.actor,
        {
          compensationNo: input.compensationNo,
          approvalToken: input.approvalToken,
        },
        context.runId ?? undefined,
      )
      return {
        compensationNo: result.compensationNo,
        status: result.status,
        amountCents: result.amountCents,
        idempotencyKey: result.idempotencyKey,
      }
    },
  )

  registry.register(
    'create_price_protection',
    async (input: ToolInput<'create_price_protection'>, context) => {
      const result = await deps.priceProtectionService.createPriceProtection(
        context.actor,
        {
          orderNo: input.orderNo,
          itemIds: input.itemIds,
        },
        context.runId ?? undefined,
      )
      return {
        protectionNo: result.protectionNo,
        status: result.status,
        policyOutcome: result.policyOutcome,
        policyExplanation: result.policyExplanation,
        refundAmountCents: result.refundAmountCents,
        requiresApproval: result.requiresApproval,
        items: result.items,
      }
    },
  )

  registry.register(
    'execute_price_protection',
    async (input: ToolInput<'execute_price_protection'>, context) => {
      const result = await deps.priceProtectionService.executePriceProtection(
        context.actor,
        {
          protectionNo: input.protectionNo,
          approvalToken: input.approvalToken,
        },
        context.runId ?? undefined,
      )
      return {
        protectionNo: result.protectionNo,
        status: result.status,
        amountCents: result.amountCents,
        idempotencyKey: result.idempotencyKey,
      }
    },
  )

  registry.register('escalate_to_human', async (input: ToolInput<'escalate_to_human'>, context) => {
    await deps.auditService.record(
      context.actor,
      'escalated_to_human',
      'conversation',
      context.runId ?? '-',
      {
        reason: input.reason,
      },
      context.runId ?? undefined,
    )
    return { escalated: true as const, reason: input.reason }
  })

  registry.assertComplete()
  return registry
}

/** 供组合根声明的工具名列表 */
export const ALL_TOOL_NAMES: ToolName[] = [
  'lookup_customer',
  'get_order',
  'get_shipment',
  'get_policy',
  'search_policy',
  'create_return_request',
  'record_return_shipment',
  'receive_return_goods',
  'execute_refund',
  'cancel_return_request',
  'create_compensation',
  'execute_compensation',
  'create_price_protection',
  'execute_price_protection',
  'escalate_to_human',
]
