/**
 * 物流事件注入领域服务
 *
 * 会话中途的物流状态变化入口 运营端点与评测剧本共用
 * 注入即校验 订单存在 运单存在 已签收订单拒绝状态回退
 * 事件 id 幂等 重复注入直接拒绝 更新运单状态并追加轨迹 审计落库
 * 触达语义由 Agent 层按会话状态决定 本服务不感知会话
 */

import type { LogisticsEventStatus } from '@aftersales/contracts'
import { createToolError } from '@aftersales/contracts'
import type { Actor, Shipment } from '../entities.js'
import { DomainError } from '../repositories.js'
import type { OrderRepository, ShipmentRepository } from '../repositories.js'
import type { AuditService } from './audit-service.js'
import type { Clock } from '../clock.js'
import { toIso } from '../clock.js'

export interface InjectLogisticsEventInput {
  orderNo: string
  status: LogisticsEventStatus
  description: string
  /** 事件唯一标识 重复注入按此幂等拒绝 */
  eventId: string
  /** 注入来源 运营端点手动注入或评测剧本触发 */
  source: 'operator' | 'simulator'
  runId?: string
}

/** 注入结果 即落表事件的 payload 快照 Agent 层据此驱动触达 */
export interface InjectLogisticsEventResult {
  shipmentId: string
  orderNo: string
  carrier: string
  trackingNo: string
  status: LogisticsEventStatus
  description: string
  eventId: string
  source: 'operator' | 'simulator'
  injectedAt: string
}

export class LogisticsEventService {
  constructor(
    private readonly shipmentRepo: ShipmentRepository,
    private readonly orderRepo: OrderRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async inject(actor: Actor, input: InjectLogisticsEventInput): Promise<InjectLogisticsEventResult> {
    const order = await this.orderRepo.findByOrderNo(input.orderNo)
    if (!order) {
      throw new DomainError(
        createToolError('NOT_FOUND', `订单不存在 ${input.orderNo}`, {
          resourceType: 'order',
          resourceId: input.orderNo,
        }),
      )
    }
    const shipment = await this.shipmentRepo.findByOrderNo(input.orderNo)
    if (!shipment) {
      throw new DomainError(
        createToolError('NOT_FOUND', `订单没有物流记录 ${input.orderNo}`, {
          resourceType: 'order',
          resourceId: input.orderNo,
        }),
      )
    }
    // 已签收订单物流状态不可回退 事件注入直接拒绝
    if (shipment.status === 'delivered') {
      throw new DomainError(
        createToolError('CONFLICT', `订单已签收 物流状态不可回退 ${input.orderNo}`, {
          resourceType: 'shipment',
          resourceId: shipment.shipmentId,
        }),
      )
    }
    // 事件 id 幂等 重复注入直接拒绝
    if (shipment.events.some((entry) => entry.eventId === input.eventId)) {
      throw new DomainError(
        createToolError('CONFLICT', `物流事件重复注入 ${input.eventId}`, {
          resourceType: 'shipment',
          resourceId: shipment.shipmentId,
        }),
      )
    }

    const now = toIso(this.clock.now())
    const updated: Shipment = {
      ...shipment,
      status: input.status,
      events: [
        ...shipment.events,
        { time: now, description: input.description, eventId: input.eventId },
      ],
      updatedAt: now,
    }
    await this.shipmentRepo.update(updated)

    await this.audit.record(
      actor,
      'logistics_event_injected',
      'shipment',
      shipment.shipmentId,
      {
        orderNo: input.orderNo,
        status: input.status,
        description: input.description,
        eventId: input.eventId,
        source: input.source,
      },
      input.runId,
    )

    return {
      shipmentId: shipment.shipmentId,
      orderNo: input.orderNo,
      carrier: shipment.carrier,
      trackingNo: shipment.trackingNo,
      status: input.status,
      description: input.description,
      eventId: input.eventId,
      source: input.source,
      injectedAt: now,
    }
  }
}
