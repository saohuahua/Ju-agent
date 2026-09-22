/**
 * 主链路用例 查单 查物流 政策解释 各类售后正常完成
 */

import type { EvalCaseInput } from '@aftersales/contracts'
import { NEW_RETURN_NO, action, argOf, final, runStatus, toolCall } from './helpers.js'

export const happyPathCases: EvalCaseInput[] = [
  {
    id: 'hp_query_order_status',
    category: 'happy_path',
    priority: 'P1',
    description: '客户查询订单状态 Agent 查单后给出答复',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '想知道自己订单 SO-2026-0002 现在到哪了 什么时候能收到',
      known: ['订单号 SO-2026-0002', '下单大概一周前'],
      instructions: '只关心订单状态和预计送达 得到明确答复即结束 不提退货',
    },
    turns: [{ userMessage: '我的订单 SO-2026-0002 到哪了' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0002' }),
      final('您的订单已发货 正在运输途中 预计两天内送达', '查单完成'),
    ],
    assertions: {
      expectedState: [runStatus('completed')],
      trajectory: {
        requiredTools: ['get_order'],
        forbiddenTools: ['create_return_request', 'execute_refund'],
        maxToolCalls: 3,
      },
      communicateInfo: ['运输'],
      judgeRubric: ['答复基于查询结果 未编造状态'],
    },
  },
  {
    id: 'hp_query_shipment_detail',
    category: 'happy_path',
    priority: 'P1',
    description: '客户查询物流轨迹 Agent 查物流并给出轨迹答复',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0002 显示已发货 想了解具体物流轨迹到哪了',
      known: ['订单号 SO-2026-0002', '收到发货通知短信'],
      instructions: '想知道物流轨迹和承运商 得到具体轨迹信息即结束',
    },
    turns: [{ userMessage: '订单 SO-2026-0002 的物流到哪了 帮我看看轨迹' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0002' }),
      toolCall('get_shipment', { orderNo: 'SO-2026-0002' }),
      final('您的包裹由顺丰承运 目前在上海浦东分拨中心 运输正常', '物流查询完成'),
    ],
    assertions: {
      expectedState: [runStatus('completed')],
      trajectory: {
        requiredTools: ['get_shipment'],
      },
    },
  },
  {
    id: 'hp_policy_explain',
    category: 'happy_path',
    priority: 'P2',
    description: '客户咨询退货政策 Agent 检索政策并解释 不发起动作',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '买之前想弄清楚退货政策 哪些商品不能无理由退 运费谁出',
      known: ['最近想买生鲜和定制品', '听说过七天无理由但不清楚细节'],
      instructions: '咨询政策细节 关注不能退的品类和时限 得到清楚解释即结束 不发起退货',
    },
    turns: [{ userMessage: '你们的退货政策是什么 哪些不能无理由退' }],
    modelScript: [
      toolCall('search_policy', { query: '退货政策 无理由 生鲜 定制 运费' }),
      final('七天无理由退货需要签收七天内 且生鲜 定制 虚拟商品不支持 运费由您承担', '政策解释完成'),
    ],
    assertions: {
      expectedState: [runStatus('completed')],
      trajectory: {
        requiredTools: ['search_policy'],
        forbiddenTools: ['create_return_request', 'execute_refund'],
      },
    },
  },
  {
    id: 'hp_refund_only_small',
    category: 'happy_path',
    priority: 'P0',
    description: '小额未发货仅退款 全自动完成 全额原路退回',
    actor: { role: 'customer', customerId: 'C1002' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0009 迟迟不发货 不想要了 要求直接退款',
      known: ['订单号 SO-2026-0009', '下单后一直没收到发货通知', '支付方式是微信'],
      instructions:
        '开场第一句明确提出订单未发货不想要了要求仅退款 不咨询物流状态 不提其他问题 被确认退款已受理且说明原路退回即结束',
    },
    turns: [{ userMessage: '订单 SO-2026-0009 还没发货 我不要了 直接退款' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0009' }),
      action(
        'submit_refund_only',
        { orderNo: 'SO-2026-0009', reason: 'unshipped_cancel' },
        '订单未发货 用户申请仅退款',
      ),
      final('已为您办理仅退款 89 元将原路退回微信支付 请留意到账', '小额仅退款完成'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'return_requests',
          where: { return_no: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'completed',
        },
        {
          table: 'refunds',
          where: { return_no: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'succeeded',
        },
        {
          table: 'refunds',
          where: { return_no: NEW_RETURN_NO },
          field: 'amount_cents',
          op: 'eq',
          value: 8_900,
        },
      ],
      trajectory: {
        requiredTools: ['get_order', 'create_return_request', 'execute_refund'],
        orderedSubsequence: ['get_order', 'create_return_request', 'execute_refund'],
        toolArgs: [argOf('execute_refund', 'returnNo', NEW_RETURN_NO)],
      },
      expectGatewayCharges: 1,
      communicateInfo: ['原路'],
      judgeRubric: ['明确告知退款金额或全额', '未在退款完成前过度承诺到账时间'],
    },
  },
  {
    id: 'hp_return_no_reason',
    category: 'happy_path',
    priority: 'P0',
    description: '七天无理由退货 售后单停在待寄回 退款预留不提前执行',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0003 里的键盘用不上想退 走七天无理由',
      known: ['订单号 SO-2026-0003', '签收没几天', '键盘完好不影响二次销售'],
      instructions: '申请七天无理由退货 确认售后单已创建且知道寄回地址流程即结束 不要求立即退款',
    },
    turns: [{ userMessage: '订单 SO-2026-0003 的键盘不想要了 七天无理由退货' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action(
        'submit_return',
        { orderNo: 'SO-2026-0003', reason: 'no_reason' },
        '签收五天内无理由退货',
      ),
      final(
        '售后单已创建 请在七天内寄回商品 寄回后我们将原路退款 运费需您承担',
        '无理由退货创建完成',
      ),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'return_requests',
          where: { return_no: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'awaiting_buyer_shipment',
        },
        {
          table: 'refunds',
          where: { return_no: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'created',
        },
      ],
      trajectory: {
        requiredTools: ['get_order', 'create_return_request'],
        forbiddenTools: ['execute_refund'],
      },
      expectGatewayCharges: 0,
      communicateInfo: ['寄回'],
      judgeRubric: ['说明了需要先寄回商品再退款', '未承诺立即退款'],
    },
  },
  {
    id: 'hp_exchange_create',
    category: 'happy_path',
    priority: 'P1',
    description: '质量问题换货 创建售后单 不产生退款记录',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0003 的键盘有质量问题 按键失灵 要求换新',
      known: ['订单号 SO-2026-0003', '键盘按键失灵', '购买两周内'],
      instructions: '要求换货不要退款 确认换货单已创建即结束',
    },
    turns: [{ userMessage: '订单 SO-2026-0003 的键盘有质量问题 我要换一个新的' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action('submit_exchange', { orderNo: 'SO-2026-0003', reason: 'quality' }, '质量问题申请换货'),
      final('换货售后单已创建 寄回商品收到后我们将重新发货', '换货创建完成'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'return_requests',
          where: { return_no: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'awaiting_buyer_shipment',
        },
        {
          table: 'refunds',
          where: { return_no: NEW_RETURN_NO },
          field: 'refund_no',
          op: 'missing',
        },
      ],
      trajectory: {
        requiredTools: ['get_order', 'create_return_request'],
        forbiddenTools: ['execute_refund'],
      },
      expectGatewayCharges: 0,
    },
  },
  {
    id: 'hp_lost_package_refund',
    category: 'happy_path',
    priority: 'P0',
    description: '物流丢件仅退款 查订单查物流后全额退款',
    actor: { role: 'customer', customerId: 'C1003' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0010 的鞋显示派送中却一直没收到 怀疑丢件 要求退款',
      known: ['订单号 SO-2026-0010', '物流信息停在几天前', '没收到任何包裹'],
      instructions: '要求全额退款 若对方说要先核实物流 可以接受等待 但要明确退款金额',
    },
    turns: [{ userMessage: '订单 SO-2026-0010 的鞋一直没到 物流显示丢件了 要求退款' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0010' }),
      toolCall('get_shipment', { orderNo: 'SO-2026-0010' }),
      action(
        'submit_refund_only',
        { orderNo: 'SO-2026-0010', reason: 'lost_package' },
        '物流确认丢件 申请全额退款',
      ),
      final('物流已确认丢件 599 元全额退款将原路退回 很抱歉给您带来不便', '丢件退款完成'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'return_requests',
          where: { return_no: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'completed',
        },
        {
          table: 'refunds',
          where: { return_no: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'succeeded',
        },
        {
          table: 'refunds',
          where: { return_no: NEW_RETURN_NO },
          field: 'amount_cents',
          op: 'eq',
          value: 59_900,
        },
      ],
      trajectory: {
        requiredTools: ['get_order', 'get_shipment', 'create_return_request', 'execute_refund'],
        orderedSubsequence: [
          'get_order',
          'get_shipment',
          'create_return_request',
          'execute_refund',
        ],
      },
      expectGatewayCharges: 1,
      communicateInfo: ['原路'],
    },
  },
  {
    id: 'hp_quality_return_create',
    category: 'happy_path',
    priority: 'P1',
    description: '质量问题退货 15 天窗口内受理 运费商家承担 退款预留不提前执行',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0003 的键盘按键失灵 走质量问题退货退款',
      known: ['订单号 SO-2026-0003', '键盘到手就有按键失灵', '签收没几天'],
      instructions:
        '要求质量问题退货退款 确认售后单已创建且知道质量问题运费商家承担即结束 不要求立即退款',
    },
    turns: [{ userMessage: '订单 SO-2026-0003 的键盘按键失灵 质量问题退货退款' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action(
        'submit_return',
        { orderNo: 'SO-2026-0003', reason: 'quality' },
        '质量问题退货 签收 15 天内',
      ),
      final('质量退货单已创建 请寄回商品 质量问题运费由商家承担 收货后退款', '质量退货创建完成'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'return_requests',
          where: { return_no: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'awaiting_buyer_shipment',
        },
        {
          table: 'refunds',
          where: { return_no: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'created',
        },
      ],
      trajectory: {
        requiredTools: ['get_order', 'create_return_request'],
        forbiddenTools: ['execute_refund'],
      },
      expectGatewayCharges: 0,
      communicateInfo: ['寄回'],
      judgeRubric: ['说明了质量问题运费由商家承担', '未承诺立即退款'],
    },
  },
  {
    id: 'hp_customer_profile_query',
    category: 'happy_path',
    priority: 'P2',
    description: '客户查询自己的账户档案 工具返回脱敏信息',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '想核对账户登记的姓名和手机号是否正确',
      known: ['自己的姓名张伟', '手机号是 138 开头'],
      instructions: '请对方查一下账户档案 确认登记姓名正确即结束',
    },
    turns: [{ userMessage: '帮我查下我账户里登记的姓名和手机号' }],
    modelScript: [
      toolCall('lookup_customer', { customerId: 'C1001' }),
      final('您登记的姓名为张伟 手机号 138****1234', '账户档案查询完成'),
    ],
    assertions: {
      expectedState: [runStatus('completed')],
      trajectory: {
        requiredTools: ['lookup_customer'],
        forbiddenTools: ['create_return_request', 'execute_refund'],
      },
      communicateInfo: ['138****1234'],
      judgeRubric: ['返回了脱敏后的手机号 未泄露完整号码'],
    },
  },
  {
    id: 'hp_delayed_delivery_inquiry',
    category: 'happy_path',
    priority: 'P2',
    description: '发货三天未更新物流 客户询问是否延误 Agent 查单查物流后安抚解释',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0002 发货三天了物流没更新 担心是不是丢了',
      known: ['订单号 SO-2026-0002', '收到过发货通知', '物流页面三天没动静'],
      instructions: '询问物流为什么没更新 得到明确的运输状态解释即结束 不要求退款',
    },
    turns: [{ userMessage: '订单 SO-2026-0002 发货三天了怎么物流一直没更新 是不是丢了' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0002' }),
      toolCall('get_shipment', { orderNo: 'SO-2026-0002' }),
      final('您的包裹正在运输途中 已到达上海浦东分拨中心 运输正常 预计两天内送达', '延误咨询完成'),
    ],
    assertions: {
      expectedState: [runStatus('completed')],
      trajectory: {
        requiredTools: ['get_order', 'get_shipment'],
        forbiddenTools: ['create_return_request', 'execute_refund'],
      },
      communicateInfo: ['运输'],
      judgeRubric: ['基于物流轨迹解释 未编造物流信息'],
    },
  },
  {
    id: 'hp_quality_policy_explain',
    category: 'happy_path',
    priority: 'P2',
    description: '客户咨询质量问题政策 Agent 检索政策解释 不发起动作',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '最近收到的东西有问题 想先了解质量问题退换政策',
      known: ['买的东西可能有质量问题', '想了解质量问题的退换时限'],
      instructions: '咨询质量问题政策 关注时限与运费 得到清楚解释即结束 不发起售后',
    },
    turns: [{ userMessage: '你们质量问题退换货的政策是什么 多久之内可以' }],
    modelScript: [
      toolCall('search_policy', { query: '质量问题 退换 时限 运费' }),
      final('质量问题自签收起 15 天内可退换 运费由商家承担', '质量政策解释完成'),
    ],
    assertions: {
      expectedState: [runStatus('completed')],
      trajectory: {
        requiredTools: ['search_policy'],
        forbiddenTools: ['create_return_request', 'execute_refund'],
      },
      communicateInfo: ['15'],
      judgeRubric: ['解释与系统政策一致 未编造时限'],
    },
  },
]
