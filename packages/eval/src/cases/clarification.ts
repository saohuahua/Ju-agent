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
    },
  },
  {
    id: 'cl_missing_reason',
    category: 'clarification',
    priority: 'P1',
    description: '退货缺少原因 补问后按七天无理由受理',
    actor: { role: 'customer', customerId: 'C1001' },
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
    },
  },
  {
    id: 'cl_exchange_or_return_choice',
    category: 'clarification',
    priority: 'P1',
    description: '质量问题处理方式不明 补问换货还是退货',
    actor: { role: 'customer', customerId: 'C1001' },
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
    },
  },
]
