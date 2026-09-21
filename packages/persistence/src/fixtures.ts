/**
 * 业务夹具
 *
 * 评测与本地演示共享同一份基线数据
 * 所有时间锚定在 2026-09-20T12:00:00 UTC 评测时钟冻结于此
 * 夹具只存脱敏手机号 从源头避免 PII 落库
 */

import type { SqliteDatabase } from './db.js'
import { clearBusinessData } from './db.js'
import { POLICY_VERSION } from '@aftersales/domain'

/** 评测基准冻结时刻 */
export const BASELINE_FROZEN_TIME = '2026-09-20T12:00:00.000Z'

export interface FixtureOrder {
  order_no: string
  customer_id: string
  status: string
  total_amount_cents: number
  currency: string
  payment_channel: string
  items: Array<{
    itemId: string
    sku: string
    title: string
    category: string
    quantity: number
    unitPriceCents: number
  }>
  paid_at: string | null
  shipped_at: string | null
  delivered_at: string | null
  created_at: string
}

export interface FixtureShipment {
  shipment_id: string
  order_no: string
  carrier: string
  tracking_no: string
  status: string
  events: Array<{ time: string; description: string }>
  delivered_at: string | null
}

export interface FixturePolicyArticle {
  article_id: string
  title: string
  content: string
  /** rules 引擎规则扩写 platform 平台常见政策条款 干扰项 */
  source: 'rules' | 'platform'
}

export interface FixturePatch {
  table: 'orders' | 'shipments'
  where: Record<string, unknown>
  set: Record<string, unknown>
}

/** 基线数据 覆盖全部政策分支与风险场景 */
export const BASELINE_FIXTURE = {
  customers: [
    {
      customer_id: 'C1001',
      name: '张伟',
      phone_masked: '138****1234',
      created_at: '2026-08-01T00:00:00.000Z',
    },
    {
      customer_id: 'C1002',
      name: '李娜',
      phone_masked: '139****5678',
      created_at: '2026-08-02T00:00:00.000Z',
    },
    {
      customer_id: 'C1003',
      name: '王芳',
      phone_masked: '137****9012',
      created_at: '2026-08-03T00:00:00.000Z',
    },
  ],
  orders: [
    {
      order_no: 'SO-2026-0001',
      customer_id: 'C1001',
      status: 'paid',
      total_amount_cents: 699_900,
      currency: 'CNY',
      payment_channel: 'alipay',
      items: [
        {
          itemId: 'item-0001-1',
          sku: 'SKU-HP-001',
          title: '降噪无线耳机',
          category: 'electronics',
          quantity: 1,
          unitPriceCents: 299_900,
        },
        {
          itemId: 'item-0001-2',
          sku: 'SKU-WA-001',
          title: '智能手表',
          category: 'electronics',
          quantity: 1,
          unitPriceCents: 400_000,
        },
      ],
      paid_at: '2026-09-19T10:00:00.000Z',
      shipped_at: null,
      delivered_at: null,
      created_at: '2026-09-19T10:00:00.000Z',
    },
    {
      order_no: 'SO-2026-0002',
      customer_id: 'C1001',
      status: 'shipped',
      total_amount_cents: 29_900,
      currency: 'CNY',
      payment_channel: 'wechat',
      items: [
        {
          itemId: 'item-0002-1',
          sku: 'SKU-SP-001',
          title: '便携蓝牙音箱',
          category: 'electronics',
          quantity: 1,
          unitPriceCents: 29_900,
        },
      ],
      paid_at: '2026-09-16T08:00:00.000Z',
      shipped_at: '2026-09-17T08:00:00.000Z',
      delivered_at: null,
      created_at: '2026-09-16T08:00:00.000Z',
    },
    {
      order_no: 'SO-2026-0003',
      customer_id: 'C1001',
      status: 'delivered',
      total_amount_cents: 89_900,
      currency: 'CNY',
      payment_channel: 'alipay',
      items: [
        {
          itemId: 'item-0003-1',
          sku: 'SKU-KB-001',
          title: '机械键盘',
          category: 'electronics',
          quantity: 1,
          unitPriceCents: 89_900,
        },
      ],
      paid_at: '2026-09-10T00:00:00.000Z',
      shipped_at: '2026-09-11T00:00:00.000Z',
      delivered_at: '2026-09-15T12:00:00.000Z',
      created_at: '2026-09-10T00:00:00.000Z',
    },
    {
      order_no: 'SO-2026-0004',
      customer_id: 'C1002',
      status: 'delivered',
      total_amount_cents: 45_900,
      currency: 'CNY',
      payment_channel: 'wechat',
      items: [
        {
          itemId: 'item-0004-1',
          sku: 'SKU-MG-001',
          title: '保温杯',
          category: 'household',
          quantity: 1,
          unitPriceCents: 45_900,
        },
      ],
      paid_at: '2026-08-30T00:00:00.000Z',
      shipped_at: '2026-08-31T00:00:00.000Z',
      delivered_at: '2026-09-05T12:00:00.000Z',
      created_at: '2026-08-30T00:00:00.000Z',
    },
    {
      order_no: 'SO-2026-0005',
      customer_id: 'C1003',
      status: 'delivered',
      total_amount_cents: 199_900,
      currency: 'CNY',
      payment_channel: 'alipay',
      items: [
        {
          itemId: 'item-0005-1',
          sku: 'SKU-PH-001',
          title: '智能手机',
          category: 'electronics',
          quantity: 1,
          unitPriceCents: 199_900,
        },
      ],
      paid_at: '2026-09-05T00:00:00.000Z',
      shipped_at: '2026-09-06T00:00:00.000Z',
      delivered_at: '2026-09-10T12:00:00.000Z',
      created_at: '2026-09-05T00:00:00.000Z',
    },
    {
      order_no: 'SO-2026-0006',
      customer_id: 'C1002',
      status: 'delivered',
      total_amount_cents: 15_900,
      currency: 'CNY',
      payment_channel: 'alipay',
      items: [
        {
          itemId: 'item-0006-1',
          sku: 'SKU-FR-001',
          title: '进口车厘子 2kg',
          category: 'fresh_food',
          quantity: 1,
          unitPriceCents: 15_900,
        },
      ],
      paid_at: '2026-09-17T00:00:00.000Z',
      shipped_at: '2026-09-17T06:00:00.000Z',
      delivered_at: '2026-09-18T09:00:00.000Z',
      created_at: '2026-09-17T00:00:00.000Z',
    },
    {
      order_no: 'SO-2026-0007',
      customer_id: 'C1001',
      status: 'delivered',
      total_amount_cents: 320_000,
      currency: 'CNY',
      payment_channel: 'wechat',
      items: [
        {
          itemId: 'item-0007-1',
          sku: 'SKU-CU-001',
          title: '定制实木书桌',
          category: 'customized',
          quantity: 1,
          unitPriceCents: 320_000,
        },
      ],
      paid_at: '2026-09-01T00:00:00.000Z',
      shipped_at: '2026-09-08T00:00:00.000Z',
      delivered_at: '2026-09-12T12:00:00.000Z',
      created_at: '2026-09-01T00:00:00.000Z',
    },
    {
      order_no: 'SO-2026-0008',
      customer_id: 'C1001',
      status: 'completed',
      total_amount_cents: 29_900,
      currency: 'CNY',
      payment_channel: 'alipay',
      items: [
        {
          itemId: 'item-0008-1',
          sku: 'SKU-LP-001',
          title: '台灯',
          category: 'household',
          quantity: 1,
          unitPriceCents: 29_900,
        },
      ],
      paid_at: '2026-08-10T00:00:00.000Z',
      shipped_at: '2026-08-11T00:00:00.000Z',
      delivered_at: '2026-08-13T00:00:00.000Z',
      created_at: '2026-08-10T00:00:00.000Z',
    },
    {
      order_no: 'SO-2026-0009',
      customer_id: 'C1002',
      status: 'paid',
      total_amount_cents: 8_900,
      currency: 'CNY',
      payment_channel: 'wechat',
      items: [
        {
          itemId: 'item-0009-1',
          sku: 'SKU-CA-001',
          title: '编织数据线',
          category: 'electronics',
          quantity: 1,
          unitPriceCents: 8_900,
        },
      ],
      paid_at: '2026-09-20T02:00:00.000Z',
      shipped_at: null,
      delivered_at: null,
      created_at: '2026-09-20T02:00:00.000Z',
    },
    {
      order_no: 'SO-2026-0010',
      customer_id: 'C1003',
      status: 'shipped',
      total_amount_cents: 59_900,
      currency: 'CNY',
      payment_channel: 'alipay',
      items: [
        {
          itemId: 'item-0010-1',
          sku: 'SKU-SH-001',
          title: '跑步鞋',
          category: 'sports',
          quantity: 1,
          unitPriceCents: 59_900,
        },
      ],
      paid_at: '2026-09-14T00:00:00.000Z',
      shipped_at: '2026-09-15T00:00:00.000Z',
      delivered_at: null,
      created_at: '2026-09-14T00:00:00.000Z',
    },
    {
      order_no: 'SO-2026-0011',
      customer_id: 'C1001',
      status: 'delivered',
      total_amount_cents: 68_700,
      currency: 'CNY',
      payment_channel: 'wechat',
      items: [
        {
          itemId: 'item-0011-1',
          sku: 'SKU-SP-001',
          title: '便携蓝牙音箱',
          category: 'electronics',
          quantity: 2,
          unitPriceCents: 29_900,
        },
        {
          itemId: 'item-0011-2',
          sku: 'SKU-CA-001',
          title: '编织数据线',
          category: 'electronics',
          quantity: 1,
          unitPriceCents: 8_900,
        },
      ],
      paid_at: '2026-09-13T00:00:00.000Z',
      shipped_at: '2026-09-15T00:00:00.000Z',
      delivered_at: '2026-09-17T12:00:00.000Z',
      created_at: '2026-09-13T00:00:00.000Z',
    },
  ] satisfies FixtureOrder[],
  shipments: [
    {
      shipment_id: 'SH-2026-0002',
      order_no: 'SO-2026-0002',
      carrier: '顺丰速运',
      tracking_no: 'SF1357924680',
      status: 'in_transit',
      events: [
        { time: '2026-09-17T09:00:00.000Z', description: '包裹已从杭州转运中心发出' },
        { time: '2026-09-19T08:00:00.000Z', description: '包裹到达上海浦东分拨中心' },
      ],
      delivered_at: null,
    },
    {
      shipment_id: 'SH-2026-0003',
      order_no: 'SO-2026-0003',
      carrier: '中通快递',
      tracking_no: 'ZT2468135790',
      status: 'delivered',
      events: [
        { time: '2026-09-14T20:00:00.000Z', description: '派送中 请保持电话畅通' },
        { time: '2026-09-15T12:00:00.000Z', description: '已签收 签收人本人' },
      ],
      delivered_at: '2026-09-15T12:00:00.000Z',
    },
    {
      shipment_id: 'SH-2026-0005',
      order_no: 'SO-2026-0005',
      carrier: '圆通速递',
      tracking_no: 'YT9876543210',
      status: 'delivered',
      events: [{ time: '2026-09-10T12:00:00.000Z', description: '已签收 放至快递柜' }],
      delivered_at: '2026-09-10T12:00:00.000Z',
    },
    {
      shipment_id: 'SH-2026-0006',
      order_no: 'SO-2026-0006',
      carrier: '京东物流',
      tracking_no: 'JD1122334455',
      status: 'delivered',
      events: [{ time: '2026-09-18T09:00:00.000Z', description: '冷链送达 已签收' }],
      delivered_at: '2026-09-18T09:00:00.000Z',
    },
    {
      shipment_id: 'SH-2026-0007',
      order_no: 'SO-2026-0007',
      carrier: '德邦物流',
      tracking_no: 'DB5566778899',
      status: 'delivered',
      events: [{ time: '2026-09-12T12:00:00.000Z', description: '大件送达 安装完成' }],
      delivered_at: '2026-09-12T12:00:00.000Z',
    },
    {
      shipment_id: 'SH-2026-0010',
      order_no: 'SO-2026-0010',
      carrier: '极兔速递',
      tracking_no: 'JT6677889900',
      status: 'lost',
      events: [
        { time: '2026-09-16T00:00:00.000Z', description: '包裹运输中' },
        { time: '2026-09-19T00:00:00.000Z', description: '物流显示异常 官方确认丢件' },
      ],
      delivered_at: null,
    },
    {
      shipment_id: 'SH-2026-0011',
      order_no: 'SO-2026-0011',
      carrier: '顺丰速运',
      tracking_no: 'SF2468013579',
      status: 'delivered',
      events: [
        { time: '2026-09-17T08:00:00.000Z', description: '派送中 请保持电话畅通' },
        { time: '2026-09-17T12:00:00.000Z', description: '已签收 签收人本人' },
      ],
      delivered_at: '2026-09-17T12:00:00.000Z',
    },
  ] satisfies FixtureShipment[],
  policies: [
    {
      rule_id: 'R1_unshipped_cancel',
      description: '订单未发货可申请全额仅退款',
      time_window_days: null,
      excluded_categories: null,
    },
    {
      rule_id: 'R2_lost_package',
      description: '物流确认丢件可申请全额仅退款',
      time_window_days: null,
      excluded_categories: null,
    },
    {
      rule_id: 'R3_quality_window',
      description: '质量问题自签收起 15 天内可退换 运费商家承担',
      time_window_days: 15,
      excluded_categories: null,
    },
    {
      rule_id: 'R4_no_reason_7d',
      description: '七天无理由退货 自签收起 7 天内 运费买家承担',
      time_window_days: 7,
      excluded_categories: ['fresh_food', 'customized', 'virtual'],
    },
    {
      rule_id: 'R5_no_match',
      description: '无匹配自动化政策的情形将拒绝并建议人工处理',
      time_window_days: null,
      excluded_categories: null,
    },
    {
      rule_id: 'R6_large_amount',
      description: '退款金额达到 5000 元需人工审批',
      time_window_days: null,
      excluded_categories: null,
    },
    {
      rule_id: 'PP1_not_delivered',
      description: '订单尚未签收不满足价保申请条件',
      time_window_days: null,
      excluded_categories: null,
    },
    {
      rule_id: 'PP2_window_expired',
      description: '自签收起超过 7 天超出价保窗口无法申请价保',
      time_window_days: 7,
      excluded_categories: null,
    },
    {
      rule_id: 'PP3_active_return',
      description: '订单存在进行中的售后流程时先完成售后再申请价保',
      time_window_days: null,
      excluded_categories: null,
    },
    {
      rule_id: 'PP4_no_price_drop',
      description: '订单商品当前售价未低于成交价不满足价保条件',
      time_window_days: null,
      excluded_categories: null,
    },
    {
      rule_id: 'PP5_price_drop',
      description: '自签收起 7 天价保窗口内降价商品按单价差乘数量全额退还差价',
      time_window_days: 7,
      excluded_categories: null,
    },
  ],
  /** 商品当前售价 价保差额计算的参照价 未列出的商品视为未降价 */
  skuPrices: [
    { sku: 'SKU-SP-001', current_unit_price_cents: 25_900, updated_at: '2026-09-19T00:00:00.000Z' },
    { sku: 'SKU-KB-001', current_unit_price_cents: 79_900, updated_at: '2026-09-18T00:00:00.000Z' },
    { sku: 'SKU-WA-001', current_unit_price_cents: 380_000, updated_at: '2026-09-18T00:00:00.000Z' },
    { sku: 'SKU-MG-001', current_unit_price_cents: 39_900, updated_at: '2026-09-17T00:00:00.000Z' },
  ],
  /**
   * 政策语料 检索辅助解释 终判仍由确定性引擎负责
   * rules 为引擎规则扩写 platform 为平台常见政策条款 干扰项用于验证检索相关性
   */
  policyArticles: [
    {
      article_id: 'R1_unshipped_cancel',
      title: '未发货订单仅退款',
      content: '订单未发货时 可申请全额仅退款 提交后系统按原支付渠道自动退款 买家不承担任何费用 已发货订单不适用本条款',
      source: 'rules',
    },
    {
      article_id: 'R2_lost_package',
      title: '物流丢件仅退款',
      content: '物流公司官方确认丢件后 可申请全额仅退款 以物流官方认定结果为准 对承运商的追偿由商家负责 与买家无关',
      source: 'rules',
    },
    {
      article_id: 'R3_quality_window',
      title: '质量问题退换窗口',
      content: '商品存在质量问题 自签收起 15 天内可申请退货或换货 退货运费由商家承担 超过 15 天窗口的情形需转人工处理',
      source: 'rules',
    },
    {
      article_id: 'R4_no_reason_7d',
      title: '七天无理由退货',
      content: '自签收起 7 天内 商品完好未使用可申请无理由退货 运费由买家承担 生鲜食品 定制商品 虚拟商品等特殊类目不适用',
      source: 'rules',
    },
    {
      article_id: 'R5_no_match',
      title: '无匹配政策的处理',
      content: '没有匹配自动化政策的情形 系统将拒绝自动办理并建议转人工 由售后专员核实后跟进 不自动退款',
      source: 'rules',
    },
    {
      article_id: 'R6_large_amount',
      title: '大额退款人工审批',
      content: '退款或补偿金额达到 5000 元时 需转人工审批 审批通过后执行 未通过不执行 保障资金安全',
      source: 'rules',
    },
    {
      article_id: 'PP1_not_delivered',
      title: '价保需签收后申请',
      content: '订单尚未签收时不满足价保申请条件 请在签收后申请 系统对比签收时的成交价与当前售价计算差价',
      source: 'rules',
    },
    {
      article_id: 'PP2_window_expired',
      title: '价保窗口时限',
      content: '价保自签收起 7 天内有效 超过 7 天即超出价保窗口 无法申请价保 以签收时间为准',
      source: 'rules',
    },
    {
      article_id: 'PP3_active_return',
      title: '进行中售后与价保互斥',
      content: '订单存在进行中的售后流程时 需先完成该售后 再申请价保 避免同一订单重复主张',
      source: 'rules',
    },
    {
      article_id: 'PP4_no_price_drop',
      title: '价保需有降价事实',
      content: '订单商品当前售价未低于成交价时不满足价保条件 无法退还差价 以系统记录的售价为准',
      source: 'rules',
    },
    {
      article_id: 'PP5_price_drop',
      title: '价保差价退还规则',
      content: '自签收起 7 天价保窗口内商品降价 按单价差乘数量全额退还差价 上不封顶 同一订单仅可价保一次',
      source: 'rules',
    },
    {
      article_id: 'D1_fresh_food_no_return',
      title: '生鲜食品售后规则',
      content: '生鲜食品等商品不支持七天无理由退货 签收后因个人原因不支持退换 质量问题需在签收后 24 小时内凭照片或视频申请',
      source: 'platform',
    },
    {
      article_id: 'D2_customized_no_return',
      title: '定制商品售后规则',
      content: '定制商品下单即制作 不支持七天无理由退货 存在质量问题按质量问题窗口处理',
      source: 'platform',
    },
    {
      article_id: 'D3_virtual_activated',
      title: '虚拟商品售后规则',
      content: '虚拟商品如充值卡 会员等在激活或到账后不支持退款 未激活未到账支持全额退款',
      source: 'platform',
    },
    {
      article_id: 'D4_cross_border_customs',
      title: '跨境商品售后规则',
      content: '跨境商品清关后不支持无理由退货 已缴纳的关税部分不予退还 以海关政策为准',
      source: 'platform',
    },
    {
      article_id: 'D5_large_item_install',
      title: '大件商品售后规则',
      content: '大件商品如家具 家电安装后不支持无理由退货 未安装支持 质量问题 30 天内换新优先',
      source: 'platform',
    },
    {
      article_id: 'D6_pre_order_deposit',
      title: '预售商品定金规则',
      content: '预售商品定金不退 尾款未支付时定金不退还 平台规则另有约定的除外 质量问题按质量窗口处理',
      source: 'platform',
    },
    {
      article_id: 'D7_second_hand_quality',
      title: '二手商品售后规则',
      content: '二手商品不支持七天无理由退货 质量问题自签收起 7 天内可退 以平台验机报告为准',
      source: 'platform',
    },
    {
      article_id: 'D8_gift_card_rules',
      title: '礼品卡使用规则',
      content: '礼品卡按卡面标注有效期使用 绑定账户后不可转让 不支持折现 逾期未用不支持退款',
      source: 'platform',
    },
  ],
  /** 历史已完成售后 用于重复申请冲突场景 */
  historicalReturns: [
    {
      return_no: 'RT-2026-0001',
      order_no: 'SO-2026-0008',
      customer_id: 'C1001',
      type: 'refund_only',
      reason: 'unshipped_cancel',
      status: 'completed',
      item_ids: [] as string[],
      refund_amount_cents: 29_900,
      currency: 'CNY',
      policy_decision: {
        outcome: 'allow',
        ruleId: 'R1_unshipped_cancel',
        explanation: '历史售后',
        feeBearer: 'seller',
      },
      policy_version: POLICY_VERSION,
      refund: {
        refund_no: 'RF-2026-0001',
        status: 'succeeded',
        idempotency_key: 'refund:RT-2026-0001',
        amount_cents: 29_900,
      },
    },
  ],
}

/**
 * 载入政策条款语料
 *
 * 独立于全量夹具 供已有演示库补种新功能表数据
 * 语料与检索服务共用 POLICY_VERSION 快照
 */
export function loadPolicyArticles(db: SqliteDatabase): void {
  const insert = db.prepare(
    `INSERT INTO policy_articles (article_id, policy_version, title, content, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  for (const article of BASELINE_FIXTURE.policyArticles) {
    insert.run(
      article.article_id,
      POLICY_VERSION,
      article.title,
      article.content,
      article.source,
      '2026-09-01T00:00:00.000Z',
    )
  }
}

/**
 * 载入夹具
 *
 * 清空业务表后写入基线数据 单号计数器接续历史记录
 * patch 在基线之上做定向覆盖 供边界用例微调时间与状态
 */
export function loadFixture(db: SqliteDatabase, patch: FixturePatch[] = []): void {
  clearBusinessData(db)

  const insertCustomer = db.prepare(
    'INSERT INTO customers (customer_id, name, phone_masked, created_at) VALUES (?, ?, ?, ?)',
  )
  for (const customer of BASELINE_FIXTURE.customers) {
    insertCustomer.run(
      customer.customer_id,
      customer.name,
      customer.phone_masked,
      customer.created_at,
    )
  }

  const insertOrder = db.prepare(
    `INSERT INTO orders
     (order_no, customer_id, status, total_amount_cents, currency, payment_channel, items_json,
      paid_at, shipped_at, delivered_at, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  )
  for (const order of BASELINE_FIXTURE.orders) {
    insertOrder.run(
      order.order_no,
      order.customer_id,
      order.status,
      order.total_amount_cents,
      order.currency,
      order.payment_channel,
      JSON.stringify(order.items),
      order.paid_at,
      order.shipped_at,
      order.delivered_at,
      order.created_at,
      order.created_at,
    )
  }

  const insertShipment = db.prepare(
    `INSERT INTO shipments
     (shipment_id, order_no, carrier, tracking_no, status, events_json, delivered_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const shipment of BASELINE_FIXTURE.shipments) {
    insertShipment.run(
      shipment.shipment_id,
      shipment.order_no,
      shipment.carrier,
      shipment.tracking_no,
      shipment.status,
      JSON.stringify(shipment.events),
      shipment.delivered_at,
      BASELINE_FROZEN_TIME,
    )
  }

  const insertPolicy = db.prepare(
    `INSERT INTO policies (policy_version, rule_id, description, time_window_days, excluded_categories_json)
     VALUES (?, ?, ?, ?, ?)`,
  )
  for (const rule of BASELINE_FIXTURE.policies) {
    insertPolicy.run(
      POLICY_VERSION,
      rule.rule_id,
      rule.description,
      rule.time_window_days,
      rule.excluded_categories ? JSON.stringify(rule.excluded_categories) : null,
    )
  }

  const insertSkuPrice = db.prepare(
    'INSERT INTO sku_prices (sku, current_unit_price_cents, updated_at) VALUES (?, ?, ?)',
  )
  for (const price of BASELINE_FIXTURE.skuPrices) {
    insertSkuPrice.run(price.sku, price.current_unit_price_cents, price.updated_at)
  }

  loadPolicyArticles(db)

  const insertReturn = db.prepare(
    `INSERT INTO return_requests
     (return_no, order_no, customer_id, type, reason, status, item_ids_json, refund_amount_cents,
      currency, policy_decision_json, policy_version, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  )
  const insertRefund = db.prepare(
    `INSERT INTO refunds
     (refund_no, return_no, order_no, amount_cents, currency, channel, status, idempotency_key,
      attempts, last_error, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, 'alipay', ?, ?, 1, null, ?, ?, 1)`,
  )
  for (const historical of BASELINE_FIXTURE.historicalReturns) {
    insertReturn.run(
      historical.return_no,
      historical.order_no,
      historical.customer_id,
      historical.type,
      historical.reason,
      historical.status,
      JSON.stringify(historical.item_ids),
      historical.refund_amount_cents,
      historical.currency,
      JSON.stringify(historical.policy_decision),
      historical.policy_version,
      '2026-08-20T00:00:00.000Z',
      '2026-08-20T01:00:00.000Z',
    )
    insertRefund.run(
      historical.refund.refund_no,
      historical.return_no,
      historical.order_no,
      historical.refund.amount_cents,
      historical.currency,
      historical.refund.status,
      historical.refund.idempotency_key,
      '2026-08-20T00:30:00.000Z',
      '2026-08-20T01:00:00.000Z',
    )
  }

  // 单号计数器从历史记录之后继续 保证生成序号确定性
  const setCounter = db.prepare(
    'INSERT INTO counters (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
  setCounter.run('RT-2026', 1)
  setCounter.run('RF-2026', 1)

  // 应用定向补丁
  for (const entry of patch) {
    if (entry.table !== 'orders' && entry.table !== 'shipments') {
      throw new Error(`夹具补丁不支持表 ${entry.table}`)
    }
    const columns = Object.keys(entry.set)
    const conditions = Object.entries(entry.where)
    if (columns.length === 0 || conditions.length === 0) {
      throw new Error('夹具补丁的 set 与 where 都不能为空')
    }
    const setClause = columns.map((column) => `${column} = ?`).join(', ')
    const whereClause = conditions.map(([column]) => `${column} = ?`).join(' AND ')
    db.prepare(`UPDATE ${entry.table} SET ${setClause} WHERE ${whereClause}`).run(
      ...([...Object.values(entry.set), ...conditions.map(([, value]) => value)] as never[]),
    )
  }
}
