/**
 * 价保流程用例 自签收起 7 天窗口内降价差价退还
 *
 * 差价全额退无上限 按 SKU 明细计算单价差乘数量 同一订单仅一次
 * 覆盖 整单价保 部分价保明细 重复申请拦截 窗口超期与无降价拒赔 未签收拒赔
 */

import type { EvalCaseInput } from '@aftersales/contracts'
import { NEW_PRICE_PROTECTION_NO, action, final, runStatus, toolCall } from './helpers.js'

export const priceProtectionCases: EvalCaseInput[] = [
  {
    id: 'pp_claim_full_refund',
    category: 'price_protection',
    priority: 'P0',
    description: '签收 3 天发现音箱降价 整单价保 差价 80 元全额退还',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0011 签收后三天发现音箱降价了 要求退还差价',
      known: [
        '订单号 SO-2026-0011',
        '音箱当时 299 元买入 现在只卖 259 元',
        '买了两个音箱 数据线没有降价',
      ],
      instructions: '发现商品降价 要求退还差价 确认差价金额后满意结束',
    },
    turns: [
      {
        userMessage:
          '我前两天买的订单 SO-2026-0011 音箱降价了 当时 299 一个 现在只要 259 你们得退我差价',
      },
    ],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0011' }),
      action('price_protection', { orderNo: 'SO-2026-0011' }, '音箱降价 发起整单价保'),
      final(
        '经系统对比 音箱单价 299.00元降至 259.00元 共 2 件 差价 80.00元 已为您原路退回支付账户',
        '整单价保差价退还',
      ),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'price_protections',
          where: { protection_no: NEW_PRICE_PROTECTION_NO },
          field: 'status',
          op: 'eq',
          value: 'succeeded',
        },
        {
          table: 'price_protections',
          where: { protection_no: NEW_PRICE_PROTECTION_NO },
          field: 'amount_cents',
          op: 'eq',
          value: 8_000,
        },
        {
          table: 'price_protections',
          where: { protection_no: NEW_PRICE_PROTECTION_NO },
          field: 'policy_rule_id',
          op: 'eq',
          value: 'PP5_price_drop',
        },
        {
          table: 'price_protections',
          where: { protection_no: NEW_PRICE_PROTECTION_NO },
          field: 'requires_approval',
          op: 'eq',
          value: 0,
        },
        {
          table: 'approval_requests',
          where: { resource_id: NEW_PRICE_PROTECTION_NO },
          field: 'id',
          op: 'missing',
        },
        {
          table: 'audit_logs',
          where: { action: 'price_protection_executed' },
          field: 'id',
          op: 'exists',
        },
      ],
      trajectory: {
        requiredTools: ['create_price_protection', 'execute_price_protection'],
        orderedSubsequence: ['create_price_protection', 'execute_price_protection'],
      },
      expectGatewayCharges: 1,
      communicateInfo: ['80'],
      judgeRubric: ['告知了差价金额与退还方式', '金额与系统计算一致'],
    },
  },
  {
    id: 'pp_partial_sku_detail',
    category: 'price_protection',
    priority: 'P0',
    description: '部分价保 只退降价的音箱 数据线未降价不参与 金额按 SKU 明细计算',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0011 里音箱降价了 只申请音箱的差价',
      known: [
        '订单号 SO-2026-0011',
        '音箱当时 299 元买入 现在 259 元',
        '明确只退音箱差价 数据线不申请',
      ],
      instructions: '明确只申请音箱的价保 确认差价金额后满意结束',
    },
    turns: [{ userMessage: 'SO-2026-0011 里音箱降价了 我就申请音箱的差价 数据线别算' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0011' }),
      action(
        'price_protection',
        { orderNo: 'SO-2026-0011', itemIds: ['item-0011-1'] },
        '只申请音箱的部分价保',
      ),
      final(
        '已按您指定的音箱计算 单价 299.00元降至 259.00元 共 2 件 差价 80.00元 已原路退回',
        '部分价保按明细计算',
      ),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'price_protections',
          where: { protection_no: NEW_PRICE_PROTECTION_NO },
          field: 'status',
          op: 'eq',
          value: 'succeeded',
        },
        {
          table: 'price_protections',
          where: { protection_no: NEW_PRICE_PROTECTION_NO },
          field: 'amount_cents',
          op: 'eq',
          value: 8_000,
        },
        {
          table: 'price_protections',
          where: { protection_no: NEW_PRICE_PROTECTION_NO },
          field: 'items_json',
          op: 'contains',
          value: 'SKU-SP-001',
        },
        {
          table: 'price_protections',
          where: { protection_no: NEW_PRICE_PROTECTION_NO },
          field: 'items_json',
          op: 'not_contains',
          value: 'SKU-CA-001',
          note: '未降价商品不参与价保明细',
        },
      ],
      trajectory: {
        requiredTools: ['create_price_protection', 'execute_price_protection'],
      },
      expectGatewayCharges: 1,
      communicateInfo: ['80'],
      judgeRubric: ['差价只按指定商品计算', '金额与系统计算一致'],
    },
  },
  {
    id: 'pp_duplicate_blocked',
    category: 'price_protection',
    priority: 'P0',
    description: '同一订单重复申请价保被拦截 仅第一次生效',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0011 刚退过差价 又以同样理由再要一次',
      known: ['订单号 SO-2026-0011', '上次已经拿到过价保差价', '这次用同样理由再要一次'],
      instructions: '再次索要同一订单的差价 若被告知同一订单只能价保一次 不再纠缠 结束',
    },
    turns: [
      {
        userMessage: 'SO-2026-0011 的音箱又降价了 再退一次差价 之前那次不算',
      },
    ],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0011' }),
      action('price_protection', { orderNo: 'SO-2026-0011' }, '首次价保申请'),
      final('差价 80.00元 已原路退回', '首次价保完成'),
      action('price_protection', { orderNo: 'SO-2026-0011' }, '重复申请价保'),
      final('很抱歉 该订单已经办理过价保 同一订单仅可价保一次 不能重复退还差价', '重复价保被拦截'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'price_protections',
          where: { order_no: 'SO-2026-0011' },
          field: 'id',
          op: 'count',
          value: 1,
        },
        {
          table: 'audit_logs',
          where: { action: 'price_protection_created' },
          field: 'id',
          op: 'count',
          value: 1,
        },
      ],
      expectGatewayCharges: 1,
      communicateInfo: ['一次'],
      judgeRubric: ['如实告知同一订单仅可价保一次', '未重复退还'],
    },
  },
  {
    id: 'pp_window_expired_denied',
    category: 'price_protection',
    priority: 'P0',
    description: '签收超过 7 天 价保窗口过期 拒赔并解释依据',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0011 签收十几天了 发现音箱降价 要求退差价',
      known: ['订单号 SO-2026-0011', '签收已经超过七天', '音箱现在确实比买的时候便宜'],
      instructions: '要求退还差价 若被告知已超过 7 天价保窗口无法办理 表示遗憾 结束对话',
    },
    turns: [{ userMessage: 'SO-2026-0011 的音箱现在降价了 把差价退给我' }],
    fixturePatch: [
      {
        table: 'orders',
        where: { order_no: 'SO-2026-0011' },
        set: { delivered_at: '2026-09-10T12:00:00.000Z' },
      },
    ],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0011' }),
      action('price_protection', { orderNo: 'SO-2026-0011' }, '顾客要求价保 交由系统判定'),
      final('很抱歉 您的订单自签收起已超过 7 天 超出价保窗口 无法申请价保', '价保窗口过期拒赔'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'price_protections',
          where: { protection_no: NEW_PRICE_PROTECTION_NO },
          field: 'status',
          op: 'eq',
          value: 'rejected',
        },
        {
          table: 'price_protections',
          where: { protection_no: NEW_PRICE_PROTECTION_NO },
          field: 'policy_rule_id',
          op: 'eq',
          value: 'PP2_window_expired',
        },
        {
          table: 'audit_logs',
          where: { action: 'price_protection_denied' },
          field: 'id',
          op: 'exists',
        },
      ],
      trajectory: { forbiddenTools: ['execute_price_protection'] },
      expectGatewayCharges: 0,
      communicateInfo: ['7 天'],
      judgeRubric: ['如实告知超出价保窗口', '说明了价保时限依据'],
    },
  },
  {
    id: 'pp_no_drop_denied',
    category: 'price_protection',
    priority: 'P1',
    description: '指定商品未降价 不满足价保条件 拒赔',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0011 里的数据线没有降价 却要求退差价',
      known: ['订单号 SO-2026-0011', '数据线买入价和现在售价一样', '坚持数据线也退差价'],
      instructions: '坚持数据线也要退差价 被告知该商品没有降价不满足条件后 接受解释 结束',
    },
    turns: [
      {
        userMessage: 'SO-2026-0011 里那根数据线也退下差价 别的商品都不管',
      },
    ],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0011' }),
      action(
        'price_protection',
        { orderNo: 'SO-2026-0011', itemIds: ['item-0011-2'] },
        '只申请数据线的价保',
      ),
      final('经系统查证 该订单商品当前售价未低于成交价 不满足价保条件 无法退还差价', '无降价拒赔'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'price_protections',
          where: { protection_no: NEW_PRICE_PROTECTION_NO },
          field: 'status',
          op: 'eq',
          value: 'rejected',
        },
        {
          table: 'price_protections',
          where: { protection_no: NEW_PRICE_PROTECTION_NO },
          field: 'policy_rule_id',
          op: 'eq',
          value: 'PP4_no_price_drop',
        },
      ],
      trajectory: { forbiddenTools: ['execute_price_protection'] },
      expectGatewayCharges: 0,
      communicateInfo: ['未低于'],
      judgeRubric: ['如实告知不满足价保条件及依据'],
    },
  },
  {
    id: 'pp_not_delivered_denied',
    category: 'price_protection',
    priority: 'P1',
    description: '订单尚未签收 不满足价保条件 拒赔',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0011 还在路上 看到音箱降价 想提前退差价',
      known: ['订单号 SO-2026-0011', '包裹还没签收', '看到商品降价想提前申请'],
      instructions: '包裹未签收就要求价保 被告知签收后才能申请后 接受 结束对话',
    },
    turns: [{ userMessage: 'SO-2026-0011 还在路上呢 我看到音箱降价了 现在就把差价退我' }],
    fixturePatch: [
      {
        table: 'orders',
        where: { order_no: 'SO-2026-0011' },
        set: { delivered_at: null },
      },
    ],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0011' }),
      action('price_protection', { orderNo: 'SO-2026-0011' }, '顾客要求价保 交由系统判定'),
      final('您的订单尚未签收 不满足价保申请条件 请在签收后 7 天内再来申请', '未签收拒赔'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'price_protections',
          where: { protection_no: NEW_PRICE_PROTECTION_NO },
          field: 'status',
          op: 'eq',
          value: 'rejected',
        },
        {
          table: 'price_protections',
          where: { protection_no: NEW_PRICE_PROTECTION_NO },
          field: 'policy_rule_id',
          op: 'eq',
          value: 'PP1_not_delivered',
        },
      ],
      trajectory: { forbiddenTools: ['execute_price_protection'] },
      expectGatewayCharges: 0,
      communicateInfo: ['签收'],
      judgeRubric: ['如实告知签收后才能价保', '说明了可申请的时间'],
    },
  },
]
