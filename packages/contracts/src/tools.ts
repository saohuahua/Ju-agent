/**
 * 工具契约与注册目录
 *
 * 每个工具声明 Zod 输入输出 风险等级 可见范围 超时与重试策略
 * exposedTo 是权限治理核心
 *   agent    只读工具 模型循环可以直接调用
 *   workflow 副作用工具 只有确定性工作流可以调用 模型永远碰不到
 *   operator 运营工具 只允许操作员身份触发
 */

import { z } from 'zod'
import { CompensationReason, ErrorCode, RiskLevel, ReturnType, ReturnReason } from './enums.js'

/** 金额统一用分表示的整数 避免浮点误差 */
export const MoneyCents = z.number().int().nonnegative()

export const OrderItem = z.object({
  itemId: z.string(),
  sku: z.string(),
  title: z.string(),
  category: z.string(),
  quantity: z.number().int().positive(),
  unitPriceCents: MoneyCents,
})
export type OrderItem = z.infer<typeof OrderItem>

// ---------- 各工具输入输出契约 ----------

export const ToolIO = {
  lookup_customer: {
    input: z.object({ customerId: z.string().min(1) }),
    output: z.object({
      customerId: z.string(),
      name: z.string(),
      phoneMasked: z.string(),
      orderCount: z.number().int(),
    }),
  },
  get_order: {
    input: z.object({ orderNo: z.string().min(1) }),
    output: z.object({
      orderNo: z.string(),
      customerId: z.string(),
      status: z.string(),
      totalAmountCents: MoneyCents,
      currency: z.string(),
      paymentChannel: z.string(),
      items: z.array(OrderItem),
      paidAt: z.string().nullable(),
      deliveredAt: z.string().nullable(),
      createdAt: z.string(),
    }),
  },
  get_shipment: {
    input: z.object({ orderNo: z.string().min(1) }),
    output: z.object({
      orderNo: z.string(),
      carrier: z.string(),
      trackingNo: z.string(),
      status: z.string(),
      events: z.array(z.object({ time: z.string(), description: z.string() })),
      deliveredAt: z.string().nullable(),
    }),
  },
  get_policy: {
    input: z.object({
      /** 可选主题过滤 如 七天无理由 质量问题 */
      topic: z.string().optional(),
    }),
    output: z.object({
      policyVersion: z.string(),
      rules: z.array(
        z.object({
          ruleId: z.string(),
          description: z.string(),
          timeWindowDays: z.number().int().nonnegative().nullable(),
          excludedCategories: z.array(z.string()).nullable(),
        }),
      ),
    }),
  },
  create_return_request: {
    input: z.object({
      orderNo: z.string().min(1),
      type: ReturnType,
      reason: ReturnReason,
      /** 部分退货时指定的商品 为空表示整单 */
      itemIds: z.array(z.string()).optional(),
    }),
    output: z.object({
      returnNo: z.string(),
      status: z.string(),
      policyOutcome: z.enum(['allow', 'deny', 'needs_approval']),
      policyExplanation: z.string(),
      refundNo: z.string().nullable(),
      refundAmountCents: MoneyCents,
      requiresApproval: z.boolean(),
    }),
  },
  record_return_shipment: {
    input: z.object({ returnNo: z.string().min(1), trackingNo: z.string().min(1) }),
    output: z.object({ returnNo: z.string(), status: z.string() }),
  },
  receive_return_goods: {
    input: z.object({ returnNo: z.string().min(1) }),
    output: z.object({
      returnNo: z.string(),
      status: z.string(),
      refundNo: z.string().nullable(),
      refundStatus: z.string().nullable(),
    }),
  },
  execute_refund: {
    input: z.object({
      returnNo: z.string().min(1),
      /** 高风险路径必须携带一次性审批令牌 */
      approvalToken: z.string().optional(),
    }),
    output: z.object({
      refundNo: z.string(),
      status: z.string(),
      amountCents: MoneyCents,
      idempotencyKey: z.string(),
    }),
  },
  cancel_return_request: {
    input: z.object({ returnNo: z.string().min(1) }),
    output: z.object({ returnNo: z.string(), status: z.string() }),
  },
  create_compensation: {
    input: z.object({
      orderNo: z.string().min(1),
      reason: CompensationReason,
      /** 补偿金额 与顾客协商确认后的数值 分级判定由确定性政策执行 */
      amountCents: MoneyCents,
    }),
    output: z.object({
      compensationNo: z.string(),
      status: z.string(),
      requiresApproval: z.boolean(),
      policyExplanation: z.string(),
      amountCents: MoneyCents,
    }),
  },
  execute_compensation: {
    input: z.object({
      compensationNo: z.string().min(1),
      /** 大额路径必须携带一次性审批令牌 */
      approvalToken: z.string().optional(),
    }),
    output: z.object({
      compensationNo: z.string(),
      status: z.string(),
      amountCents: MoneyCents,
      idempotencyKey: z.string(),
    }),
  },
  create_price_protection: {
    input: z.object({
      orderNo: z.string().min(1),
      /** 部分价保时指定的商品 为空表示整单 */
      itemIds: z.array(z.string()).optional(),
    }),
    output: z.object({
      protectionNo: z.string(),
      status: z.string(),
      policyOutcome: z.enum(['allow', 'deny', 'needs_approval']),
      policyExplanation: z.string(),
      refundAmountCents: MoneyCents,
      requiresApproval: z.boolean(),
      /** 命中降价的商品明细 按单价差乘数量计算 无降价时为空 */
      items: z.array(
        z.object({
          itemId: z.string(),
          sku: z.string(),
          purchasePriceCents: MoneyCents,
          currentPriceCents: MoneyCents,
          quantity: z.number().int().positive(),
          refundCents: MoneyCents,
        }),
      ),
    }),
  },
  execute_price_protection: {
    input: z.object({
      protectionNo: z.string().min(1),
      /** 大额路径必须携带一次性审批令牌 */
      approvalToken: z.string().optional(),
    }),
    output: z.object({
      protectionNo: z.string(),
      status: z.string(),
      amountCents: MoneyCents,
      idempotencyKey: z.string(),
    }),
  },
  escalate_to_human: {
    input: z.object({ reason: z.string().min(1) }),
    output: z.object({ escalated: z.literal(true), reason: z.string() }),
  },
} as const

export type ToolName = keyof typeof ToolIO

export type ToolInput<T extends ToolName> = z.infer<(typeof ToolIO)[T]['input']>
export type ToolOutput<T extends ToolName> = z.infer<(typeof ToolIO)[T]['output']>

/** 重试策略 默认对限流 超时 上游错误做一次退避重试 */
export const RetryPolicy = z.object({
  maxRetries: z.number().int().nonnegative(),
  backoffBaseMs: z.number().int().positive(),
  retryOn: z.array(ErrorCode),
})
export type RetryPolicy = z.infer<typeof RetryPolicy>

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 1,
  backoffBaseMs: 25,
  retryOn: ['RATE_LIMITED', 'TIMEOUT', 'UPSTREAM_ERROR'],
}

/** 工具描述符 生成安全目录供提示词与文档使用 */
export const ToolDescriptor = z.object({
  name: z.string(),
  risk: RiskLevel,
  exposedTo: z.enum(['agent', 'workflow', 'operator']),
  timeoutMs: z.number().int().positive(),
  idempotent: z.boolean(),
  description: z.string(),
})
export type ToolDescriptor = z.infer<typeof ToolDescriptor>

/**
 * 工具注册目录
 * 副作用工具 execute_refund 风险为 high 且幂等 模型不可见
 */
export const TOOL_CATALOG: readonly ToolDescriptor[] = [
  {
    name: 'lookup_customer',
    risk: 'low',
    exposedTo: 'agent',
    timeoutMs: 2000,
    idempotent: false,
    description: '查询客户基础信息 返回脱敏后的手机号与订单数量',
  },
  {
    name: 'get_order',
    risk: 'low',
    exposedTo: 'agent',
    timeoutMs: 2000,
    idempotent: false,
    description: '查询订单详情 仅返回当前身份有权访问的订单',
  },
  {
    name: 'get_shipment',
    risk: 'low',
    exposedTo: 'agent',
    timeoutMs: 2000,
    idempotent: false,
    description: '查询订单的物流轨迹',
  },
  {
    name: 'get_policy',
    risk: 'low',
    exposedTo: 'agent',
    timeoutMs: 2000,
    idempotent: false,
    description: '查询当前版本售后政策规则 用于向用户解释依据',
  },
  {
    name: 'create_return_request',
    risk: 'medium',
    exposedTo: 'workflow',
    timeoutMs: 3000,
    idempotent: false,
    description: '创建售后单并完成政策判定 由工作流调用',
  },
  {
    name: 'record_return_shipment',
    risk: 'medium',
    exposedTo: 'workflow',
    timeoutMs: 3000,
    idempotent: false,
    description: '登记买家寄回物流单号 由工作流调用',
  },
  {
    name: 'receive_return_goods',
    risk: 'medium',
    exposedTo: 'operator',
    timeoutMs: 5000,
    idempotent: true,
    description: '卖家确认收到退货并触发退款 仅操作员可用',
  },
  {
    name: 'execute_refund',
    risk: 'high',
    exposedTo: 'workflow',
    timeoutMs: 5000,
    idempotent: true,
    description: '执行原路退款 幂等键绑定售后单 重试不会重复扣款 由工作流调用 高风险路径需审批令牌',
  },
  {
    name: 'cancel_return_request',
    risk: 'medium',
    exposedTo: 'workflow',
    timeoutMs: 3000,
    idempotent: false,
    description: '取消售后单 由工作流调用',
  },
  {
    name: 'create_compensation',
    risk: 'medium',
    exposedTo: 'workflow',
    timeoutMs: 3000,
    idempotent: false,
    description: '创建补偿单并完成分级判定 小额自动发放 大额转人工审批 同订单同原因仅一次 由工作流调用',
  },
  {
    name: 'execute_compensation',
    risk: 'high',
    exposedTo: 'workflow',
    timeoutMs: 5000,
    idempotent: true,
    description: '执行现金红包补偿 原路退回支付渠道 幂等键绑定补偿单 重试不会重复发放 由工作流调用 大额路径需审批令牌',
  },
  {
    name: 'create_price_protection',
    risk: 'medium',
    exposedTo: 'workflow',
    timeoutMs: 3000,
    idempotent: false,
    description: '创建价保单 系统对比成交价与当前售价 自签收起 7 天内降价商品按单价差乘数量计算差价 同一订单仅可价保一次 由工作流调用',
  },
  {
    name: 'execute_price_protection',
    risk: 'high',
    exposedTo: 'workflow',
    timeoutMs: 5000,
    idempotent: true,
    description: '执行价保差价退还 原路退回支付渠道 幂等键绑定价保单 重试不会重复退款 由工作流调用 大额路径需审批令牌',
  },
  {
    name: 'escalate_to_human',
    risk: 'low',
    exposedTo: 'workflow',
    timeoutMs: 2000,
    idempotent: false,
    description: '升级人工客服 由工作流调用',
  },
] as const

export const TOOL_NAMES = TOOL_CATALOG.map((t) => t.name) as ToolName[]

export function findToolDescriptor(name: string): ToolDescriptor | undefined {
  return TOOL_CATALOG.find((t) => t.name === name)
}
