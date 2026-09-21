/**
 * 多轮补问用例 信息缺失时最小化提问
 */

import type { EvalCaseInput } from '@aftersales/contracts'
import { NEW_RETURN_NO, action, clarify, final, runStatus, toolCall } from './helpers.js'

export const clarificationCases: EvalCaseInput[] = [
  {
    id: 'cl_missing_order_no',
    category: 'clarification',
    priority: 'P0',
    description: '未提供订单号 先补问一次 用户答复后完成退款',
    actor: { role: 'customer', customerId: 'C1002' },
    scenario: {
      persona: 'normal',
      reasonForContact: '有个订单不想要了 想直接退款',
      known: ['自己最近下过一个单 没收到发货通知', '当时用微信支付的'],
      instructions:
        '开口只说要退款 不主动报订单号 被问到订单号时提供 SO-2026-0009 确认退款已受理并说明退回方式即结束',
    },
    turns: [
      { userMessage: '我有个订单不想要了 帮我退款' },
      { userMessage: '订单号是 SO-2026-0009' },
    ],
    modelScript: [
      clarify('请提供需要退款的订单号', ['orderNo']),
      toolCall('get_order', { orderNo: 'SO-2026-0009' }),
      action(
        'submit_refund_only',
        { orderNo: 'SO-2026-0009', reason: 'unshipped_cancel' },
        '用户补充订单号 未发货仅退款',
      ),
      final('已办理仅退款 89 元原路退回微信支付', '补问后退款完成'),
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
      ],
      trajectory: {
        requiredTools: ['get_order', 'create_return_request', 'execute_refund'],
        maxToolCalls: 5,
      },
      expectClarify: true,
      expectGatewayCharges: 1,
      communicateInfo: ['原路'],
      judgeRubric: ['信息不足时先补问而非猜测订单', '补问聚焦单一缺口 未连环盘问'],
    },
  },
  {
    id: 'cl_missing_reason',
    category: 'clarification',
    priority: 'P1',
    description: '退货缺少原因 补问后按七天无理由受理',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0003 的东西不想要了 想退货',
      known: ['订单号 SO-2026-0003', '签收没几天 商品完好'],
      instructions:
        '先只说想退货 不主动说明原因 被问到原因时回答没什么问题 就是不想要了 确认退货单已创建并知道寄回后退款即结束',
    },
    turns: [
      { userMessage: '订单 SO-2026-0003 我想退货' },
      { userMessage: '没什么问题 就是不想要了' },
    ],
    modelScript: [
      clarify('请问退货原因是什么 是商品质量问题还是无理由退货', ['reason']),
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action(
        'submit_return',
        { orderNo: 'SO-2026-0003', reason: 'no_reason' },
        '用户确认无理由退货',
      ),
      final('已按七天无理由创建退货单 寄回商品后退款 运费需您承担', '补问原因后退货创建'),
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
      ],
      expectClarify: true,
      expectGatewayCharges: 0,
      communicateInfo: ['寄回'],
      judgeRubric: ['按用户答复的原因正确归类 未二次追问'],
    },
  },
  {
    id: 'cl_exchange_or_return_choice',
    category: 'clarification',
    priority: 'P1',
    description: '质量问题处理方式不明 补问换货还是退货',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0003 的键盘到手就有问题 想知道怎么处理',
      known: ['订单号 SO-2026-0003', '键盘到手就有按键失灵'],
      instructions:
        '先描述问题询问怎么处理 不主动指定退还是换 被问到处理方式时选择换货 确认换货单已创建即结束',
    },
    turns: [
      { userMessage: '订单 SO-2026-0003 的键盘到手就有问题 怎么处理' },
      { userMessage: '换一个吧' },
    ],
    modelScript: [
      clarify('很抱歉给您带来不便 您希望退货退款还是换货', ['type']),
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action('submit_exchange', { orderNo: 'SO-2026-0003', reason: 'quality' }, '用户选择换货'),
      final('换货单已创建 寄回后为您重发新商品 运费由我们承担', '补问后换货创建'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'return_requests',
          where: { return_no: NEW_RETURN_NO },
          field: 'type',
          op: 'eq',
          value: 'exchange',
        },
      ],
      expectClarify: true,
      expectGatewayCharges: 0,
      communicateInfo: ['换货', '寄回'],
      judgeRubric: ['补问时给出退货与换货的可选项', '说明了换货重发与运费承担安排'],
    },
  },
  {
    id: 'cl_ambiguous_refund_scope',
    category: 'clarification',
    priority: 'P1',
    description: '丢件退款未说明金额范围 补问确认全额后退款',
    actor: { role: 'customer', customerId: 'C1003' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0010 的鞋丢件了 要求退钱',
      known: ['订单号 SO-2026-0010', '物流显示丢件', '付款 599 元'],
      instructions:
        '开口只说退钱 不主动说明退多少 被问到退款范围时确认整单全额退 确认退款已受理且原路退回即结束',
    },
    turns: [
      { userMessage: '订单 SO-2026-0010 丢件了 把钱退给我' },
      { userMessage: '整单都退 全额' },
    ],
    modelScript: [
      clarify('请问您是申请整单全额退款吗', ['amount']),
      toolCall('get_order', { orderNo: 'SO-2026-0010' }),
      toolCall('get_shipment', { orderNo: 'SO-2026-0010' }),
      action(
        'submit_refund_only',
        { orderNo: 'SO-2026-0010', reason: 'lost_package' },
        '用户确认全额退款',
      ),
      final('已办理丢件全额退款 599 元将原路退回 请留意到账', '确认金额后退款完成'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
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
        maxToolCalls: 8,
      },
      expectClarify: true,
      expectGatewayCharges: 1,
      communicateInfo: ['原路'],
      judgeRubric: ['退款范围不明确时先补问而非默认全额', '补问聚焦退款范围单一问题'],
    },
  },
  {
    id: 'cl_wrong_product_in_order',
    category: 'clarification',
    priority: 'P1',
    description: '客户描述的商品与订单号不一致 Agent 核对后澄清',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'confused',
      reasonForContact: '想查订单 SO-2026-0002 但记成里面是耳机 想确认是什么商品',
      known: ['订单号 SO-2026-0002', '记不清买的是耳机还是音箱'],
      instructions:
        '先说订单 SO-2026-0002 是耳机 被对方指出商品信息与订单不符时接受 确认实际商品后结束',
    },
    turns: [
      { userMessage: '我订单 SO-2026-0002 的耳机怎么还没到' },
      { userMessage: '哦对 是音箱 记错了' },
    ],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0002' }),
      clarify('经查询订单 SO-2026-0002 的商品是便携蓝牙音箱 您想了解的是这个订单吗', [
        'orderNo',
      ]),
      final('您的蓝牙音箱已发货 正在运输途中 预计两天内送达', '核对商品后完成查询'),
    ],
    assertions: {
      expectedState: [runStatus('completed')],
      expectClarify: true,
      trajectory: {
        requiredTools: ['get_order'],
        forbiddenTools: ['create_return_request', 'execute_refund'],
      },
      communicateInfo: ['音箱'],
      judgeRubric: ['发现商品描述不符时与客户核对 未直接按错误信息处理'],
    },
  },
]
