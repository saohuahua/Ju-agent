/**
 * Mock 支付网关
 *
 * 模拟支付宝 微信等外部退款渠道
 * 核心语义 幂等键去重 相同键的重复请求返回同一结果且只记一次成功扣款
 * 评测用 successCharges 记录作为重复副作用的最终证据
 */

import type { PaymentGatewayPort } from '@aftersales/domain'

export interface GatewayCallRecord {
  idempotencyKey: string
  refundNo: string
  amountCents: number
  at: string
}

export class MockPaymentGateway implements PaymentGatewayPort {
  /** 幂等键到结果的映射 去重核心 */
  private readonly settled = new Map<string, { refundNo: string; gatewayRefundId: string }>()
  /** 全部调用记录 含被幂等去重的重复调用 */
  readonly callLog: GatewayCallRecord[] = []

  async withRefund(
    idempotencyKey: string,
    request: { refundNo: string; amountCents: number; currency: string; channel: string },
  ): Promise<{ gatewayRefundId: string }> {
    this.callLog.push({
      idempotencyKey,
      refundNo: request.refundNo,
      amountCents: request.amountCents,
      at: new Date().toISOString(),
    })
    const existing = this.settled.get(idempotencyKey)
    if (existing) {
      // 幂等命中 返回首次结果 不再产生新的成功扣款
      return { gatewayRefundId: existing.gatewayRefundId }
    }
    const gatewayRefundId = `gw_${request.refundNo}`
    this.settled.set(idempotencyKey, { refundNo: request.refundNo, gatewayRefundId })
    return { gatewayRefundId }
  }

  chargeCount(idempotencyKey: string): number {
    return this.settled.has(idempotencyKey) ? 1 : 0
  }

  /** 评测断言用 成功扣款总次数 重复退款必然让这个数字大于退款单数 */
  totalSuccessfulCharges(): number {
    return this.settled.size
  }

  /** 同一幂等键的调用次数 包括被去重的 */
  callsForKey(idempotencyKey: string): number {
    return this.callLog.filter((call) => call.idempotencyKey === idempotencyKey).length
  }
}
