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
    },
  },
  {
    id: 'hp_query_shipment_detail',
    category: 'happy_path',
    priority: 'P1',
    description: '客户查询物流轨迹 Agent 先查订单再查物流',
    actor: { role: 'customer', customerId: 'C1001' },
    turns: [{ userMessage: '订单 SO-2026-0002 的物流到哪了 帮我看看轨迹' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0002' }),
      toolCall('get_shipment', { orderNo: 'SO-2026-0002' }),
      final('您的包裹由顺丰承运 目前在上海浦东分拨中心 运输正常', '物流查询完成'),
    ],
    assertions: {
      expectedState: [runStatus('completed')],
      trajectory: {
        requiredTools: ['get_order', 'get_shipment'],
        orderedSubsequence: ['get_order', 'get_shipment'],
      },
    },
  },
  {
    id: 'hp_policy_explain',
    category: 'happy_path',
    priority: 'P2',
    description: '客户咨询退货政策 Agent 检索政策并解释 不发起动作',
    actor: { role: 'customer', customerId: 'C1001' },
    turns: [{ userMessage: '你们的退货政策是什么 哪些不能无理由退' }],
    modelScript: [
      toolCall('get_policy', { topic: '无理由' }),
      final('七天无理由退货需要签收七天内 且生鲜 定制 虚拟商品不支持 运费由您承担', '政策解释完成'),
    ],
    assertions: {
      expectedState: [runStatus('completed')],
      trajectory: {
        requiredTools: ['get_policy'],
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
    },
  },
  {
    id: 'hp_return_no_reason',
    category: 'happy_path',
    priority: 'P0',
    description: '七天无理由退货 售后单停在待寄回 退款预留不提前执行',
    actor: { role: 'customer', customerId: 'C1001' },
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
    },
  },
  {
    id: 'hp_exchange_create',
    category: 'happy_path',
    priority: 'P1',
    description: '质量问题换货 创建售后单 不产生退款记录',
    actor: { role: 'customer', customerId: 'C1001' },
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
    },
  },
]
