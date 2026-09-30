/**
 * 政策引擎
 *
 * 售后政策是确定性规则 与模型输出无关
 * Agent 可以向用户解释政策 但能不能退 由这里说了算
 * 规则按序匹配 首条命中即生效 命中后统一叠加金额阈值检查
 */

import type { PolicyDecisionRecord, Order, PriceProtectionItem, Shipment } from './entities.js'
import type { Clock } from './clock.js'
import type { ReturnType, ReturnReason } from '@aftersales/contracts'

/** 政策常量 与政策表数据同源 修改规则语义时必须同步 bump 版本号 */
export const POLICY_VERSION = '2026.09-v3'

/** 无理由退货窗口天数 */
export const NO_REASON_WINDOW_DAYS = 7
/** 质量问题受理窗口天数 */
export const QUALITY_WINDOW_DAYS = 15
/** 价保窗口天数 自签收起算 超窗拒绝 */
export const PRICE_PROTECTION_WINDOW_DAYS = 7
/** 不支持无理由退货的类目 */
export const NO_REASON_EXCLUDED_CATEGORIES = ['fresh_food', 'customized', 'virtual']
/** 大额退款审批阈值 单位分 500000 即 5000 元 */
export const LARGE_REFUND_THRESHOLD_CENTS = 500_000
/**
 * 补偿自动发放阈值 单位分 5000 即 50 元
 * 决策 2026-09-21 与退款大额阈值相互独立
 */
export const COMPENSATION_AUTO_THRESHOLD_CENTS = 5_000

export interface PolicyInput {
  type: ReturnType
  reason: ReturnReason
  order: Order
  shipment: Shipment | null
  /** 部分退货的商品 为空表示整单 */
  itemIds: string[] | null
  clock: Clock
}

export type PolicyOutcome = PolicyDecisionRecord & {
  refundAmountCents: number
}

/** 计算退款金额 整单取订单总额 部分退货取命中商品小计 */
function computeRefundAmountCents(order: Order, itemIds: string[] | null): number {
  if (!itemIds || itemIds.length === 0) {
    return order.totalAmountCents
  }
  // 重复标识不重复计费 未命中的标识不会在此主动报错
  // 这里也未处理优惠券和运费分摊 不等同于完整退款余额账本
  const wanted = new Set(itemIds)
  return order.items
    .filter((item) => wanted.has(item.itemId))
    .reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0)
}

/** 整数天数仅用于解释文案 资格判断使用精确时间差 */
function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000))
}

/** 按签收后的精确毫秒差判断 恰好等于窗口仍允许 超过才拒绝 */
function withinWindow(from: Date, to: Date, windowDays: number): boolean {
  return to.getTime() - from.getTime() <= windowDays * 24 * 60 * 60 * 1000
}

/** 拒绝结果仍带参考金额 是否预留退款由业务准备逻辑决定 */
function deny(ruleId: string, explanation: string, amountCents: number): PolicyOutcome {
  return {
    outcome: 'deny',
    ruleId,
    explanation,
    feeBearer: null,
    refundAmountCents: amountCents,
  }
}

function allow(
  ruleId: string,
  explanation: string,
  feeBearer: 'seller' | 'buyer',
  amountCents: number,
): PolicyOutcome {
  return {
    outcome: 'allow',
    ruleId,
    explanation,
    feeBearer,
    refundAmountCents: amountCents,
  }
}

/**
 * 基础规则判定不写数据库 不检查订单归属或历史售后占位
 * 输出资格 金额和运费 后续还须通过完整入口叠加大额审批
 */
export function evaluatePolicy(input: PolicyInput): PolicyOutcome {
  const { type, reason, order, shipment, itemIds, clock } = input
  const amount = computeRefundAmountCents(order, itemIds)
  const now = clock.now()

  // R1 未发货取消 仅退款 全额允许
  if (type === 'refund_only' && reason === 'unshipped_cancel') {
    if (order.status === 'paid' && !order.shippedAt) {
      return allow('R1_unshipped_cancel', '订单未发货 支持全额仅退款', 'seller', amount)
    }
    return deny('R1_unshipped_cancel', '订单已发货 不适用未发货仅退款 请改走退货流程', amount)
  }

  // R2 物流丢件 仅退款 全额允许 运费商家承担
  if (type === 'refund_only' && reason === 'lost_package') {
    // 没有物流记录或仍在途都不能代替明确丢件证据
    if (shipment && shipment.status === 'lost') {
      return allow('R2_lost_package', '物流确认丢件 支持全额仅退款', 'seller', amount)
    }
    return deny(
      'R2_lost_package',
      '物流状态不是丢件 无法按丢件受理 请提供更多信息或走退货流程',
      amount,
    )
  }

  // R3 质量问题 15 天窗口内允许 超时拒绝 仅退款形式需人工确认
  if (reason === 'quality' || reason === 'damaged' || reason === 'wrong_item') {
    if (!order.deliveredAt) {
      return deny('R3_quality_window', '订单尚未签收 无法按质量问题受理', amount)
    }
    const elapsedDays = daysBetween(new Date(order.deliveredAt), now)
    if (!withinWindow(new Date(order.deliveredAt), now, QUALITY_WINDOW_DAYS)) {
      return deny(
        'R3_quality_window',
        `签收已超过 ${QUALITY_WINDOW_DAYS} 天 超出质量问题受理时限`,
        amount,
      )
    }
    // 质量问题只退钱需要人工确认 即使小额也不会自动通过
    if (type === 'refund_only') {
      return {
        outcome: 'needs_approval',
        ruleId: 'R3_quality_window',
        explanation: '质量问题仅退款需人工确认商品情况',
        feeBearer: 'seller',
        refundAmountCents: amount,
      }
    }
    return allow(
      'R3_quality_window',
      `签收 ${elapsedDays} 天 在质量问题受理窗口内 支持退换`,
      'seller',
      amount,
    )
  }

  // R4 七天无理由 仅支持退货退款 部分类目排除
  if (reason === 'no_reason' && type === 'return') {
    // 当前按整张订单排除类目 不只检查本次选中的商品行
    const excluded = order.items.some((item) =>
      NO_REASON_EXCLUDED_CATEGORIES.includes(item.category),
    )
    if (excluded) {
      return deny('R4_no_reason_7d', '订单包含生鲜 定制或虚拟商品 不支持七天无理由退货', amount)
    }
    if (!order.deliveredAt) {
      return deny('R4_no_reason_7d', '订单尚未签收 暂不能按无理由退货受理', amount)
    }
    const elapsedDays = daysBetween(new Date(order.deliveredAt), now)
    if (!withinWindow(new Date(order.deliveredAt), now, NO_REASON_WINDOW_DAYS)) {
      return deny(
        'R4_no_reason_7d',
        `签收已超过 ${NO_REASON_WINDOW_DAYS} 天 超出七天无理由窗口`,
        amount,
      )
    }
    return allow(
      'R4_no_reason_7d',
      `签收 ${elapsedDays} 天 在七天无理由窗口内 支持退货退款 寄回运费由买家承担`,
      'buyer',
      amount,
    )
  }

  // R5 兜底 无匹配政策 一律拒绝并建议人工
  return deny('R5_no_match', '当前情况没有匹配的自动化政策 建议升级人工处理', amount)
}

/**
 * 金额阈值检查 允许的结果上叠加
 * 只将基础允许的大额方案转为审批 基础拒绝仍保持拒绝
 */
export function applyLargeRefundThreshold(decision: PolicyOutcome): PolicyOutcome {
  // 金额门槛不能把政策拒绝改造成可审批的方案
  if (decision.outcome !== 'allow') {
    return decision
  }
  // 退款阈值的等号在审批侧 与补偿五十元的自动侧不同
  if (decision.refundAmountCents >= LARGE_REFUND_THRESHOLD_CENTS) {
    return {
      ...decision,
      outcome: 'needs_approval',
      ruleId: 'R6_large_amount',
      explanation: `${decision.explanation} 退款金额达到大额阈值 需人工审批`,
    }
  }
  return decision
}

/** 完整判定 政策规则叠加阈值 入口函数 */
export function decidePolicy(input: PolicyInput): PolicyOutcome {
  return applyLargeRefundThreshold(evaluatePolicy(input))
}

export interface CompensationPolicyInput {
  /** 与顾客协商确认后的补偿金额 */
  amountCents: number
}

export type CompensationPolicyOutcome = {
  outcome: 'allow' | 'needs_approval'
  ruleId: string
  explanation: string
}

/**
 * 补偿分级判定 纯函数无副作用
 * 阈值以内自动发放 以上转人工审批
 * 金额有效性校验由领域服务负责 这里只做分级
 */
export function evaluateCompensationPolicy(input: CompensationPolicyInput): CompensationPolicyOutcome {
  if (input.amountCents <= COMPENSATION_AUTO_THRESHOLD_CENTS) {
    return {
      outcome: 'allow',
      ruleId: 'C1_auto_small',
      explanation: `补偿金额 ${input.amountCents} 分 在自动发放阈值内 直接发放现金红包`,
    }
  }
  return {
    outcome: 'needs_approval',
    ruleId: 'C2_large_approval',
    explanation: `补偿金额 ${input.amountCents} 分 超出自动发放阈值 需人工审批`,
  }
}

export interface PriceProtectionPolicyInput {
  order: Order
  /** 部分价保指定的商品 为空表示整单 */
  itemIds: string[] | null
  /** 当前售价查询 返回命中 SKU 的当前价 无记录表示该商品未降价 */
  priceLookup: (sku: string) => number | null
  /** 订单是否存在进行中的售后 退货中订单不参与价保 */
  activeReturn: boolean
  now: Date
}

export type PriceProtectionPolicyOutcome = {
  outcome: 'allow' | 'deny' | 'needs_approval'
  ruleId: string
  explanation: string
  refundAmountCents: number
  /** 命中降价的商品明细 按单价差乘数量计算 拒绝时为空 */
  items: PriceProtectionItem[]
}

/** 分转元展示串 政策文案统一用元与用户沟通 */
function formatYuan(cents: number): string {
  return `${(cents / 100).toFixed(2)}元`
}

/**
 * 价保政策判定 纯函数无副作用
 *
 * 决策 2026-09-21 差价全额退无上限 支持按 SKU 明细的部分价保
 * 只退降价商品的单价差乘数量 未降价商品不参与计算
 * 规则按序匹配 首条命中即生效
 */
export function evaluatePriceProtectionPolicy(
  input: PriceProtectionPolicyInput,
): PriceProtectionPolicyOutcome {
  const { order, itemIds, priceLookup, activeReturn, now } = input
  const deny = (
    ruleId: string,
    explanation: string,
  ): PriceProtectionPolicyOutcome => ({
    outcome: 'deny',
    ruleId,
    explanation,
    refundAmountCents: 0,
    items: [],
  })

  // PP1 未签收订单不参与价保
  if (!order.deliveredAt) {
    return deny('PP1_not_delivered', '订单尚未签收 不满足价保申请条件')
  }

  // PP2 自签收起 7 天窗口 超窗拒绝
  const deliveredAt = new Date(order.deliveredAt)
  if (!withinWindow(deliveredAt, now, PRICE_PROTECTION_WINDOW_DAYS)) {
    return deny(
      'PP2_window_expired',
      `自签收起已超过 ${PRICE_PROTECTION_WINDOW_DAYS} 天 超出价保窗口 无法申请价保`,
    )
  }

  // PP3 退货进行中的订单不参与价保
  if (activeReturn) {
    return deny('PP3_active_return', '订单存在进行中的售后流程 请先完成售后再申请价保')
  }

  // 只计算降价商品的单价差乘数量 未降价商品不参与
  const wanted = itemIds && itemIds.length > 0 ? new Set(itemIds) : null
  const drops = order.items
    .filter((item) => !wanted || wanted.has(item.itemId))
    .map((item) => ({ item, currentPriceCents: priceLookup(item.sku) }))
    .filter(
      (entry): entry is { item: (typeof order.items)[number]; currentPriceCents: number } =>
        entry.currentPriceCents !== null &&
        entry.currentPriceCents < entry.item.unitPriceCents,
    )

  // PP4 无降价商品 不满足价保条件
  if (drops.length === 0) {
    return deny('PP4_no_price_drop', '经查证 该订单商品当前售价未低于成交价 不满足价保条件')
  }

  // PP5 窗口内降价 全额退还差价
  const items: PriceProtectionItem[] = drops.map((entry) => ({
    itemId: entry.item.itemId,
    sku: entry.item.sku,
    purchasePriceCents: entry.item.unitPriceCents,
    currentPriceCents: entry.currentPriceCents,
    quantity: entry.item.quantity,
    refundCents: (entry.item.unitPriceCents - entry.currentPriceCents) * entry.item.quantity,
  }))
  const refundAmountCents = items.reduce((sum, item) => sum + item.refundCents, 0)
  const breakdown = items
    .map(
      (item) =>
        `${item.sku} ${formatYuan(item.purchasePriceCents)}→${formatYuan(item.currentPriceCents)}×${item.quantity}`,
    )
    .join(' ')
  return {
    outcome: 'allow',
    ruleId: 'PP5_price_drop',
    explanation: `自签收起在 ${PRICE_PROTECTION_WINDOW_DAYS} 天价保窗口内 降价商品 ${items.length} 件 ${breakdown} 合计差价 ${formatYuan(refundAmountCents)}`,
    refundAmountCents,
    items,
  }
}

/** 完整价保判定 政策规则叠加金额阈值 入口函数 */
export function decidePriceProtectionPolicy(
  input: PriceProtectionPolicyInput,
): PriceProtectionPolicyOutcome {
  const decision = evaluatePriceProtectionPolicy(input)
  if (
    decision.outcome === 'allow' &&
    decision.refundAmountCents >= LARGE_REFUND_THRESHOLD_CENTS
  ) {
    return {
      ...decision,
      outcome: 'needs_approval',
      ruleId: 'R6_large_amount',
      explanation: `${decision.explanation} 差价金额达到大额阈值 需人工审批`,
    }
  }
  return decision
}
