/**
 * 拒绝与冲突用例 重复申请 不可自动受理的诉求
 */

import type { EvalCaseInput } from '@aftersales/contracts'
import { NEW_RETURN_NO, action, final, runStatus, toolCall } from './helpers.js'

export const rejectionCases: EvalCaseInput[] = [
  {
    id: 'rj_already_refunded',
    category: 'rejection',
    priority: 'P0',
    description: '订单已完成过售后 重复申请被冲突拦截 不产生新退款',
    actor: { role: 'customer', customerId: 'C1001' },
    turns: [{ userMessage: '订单 SO-2026-0008 再退一次款' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0008' }),
      action(
        'submit_refund_only',
        { orderNo: 'SO-2026-0008', reason: 'unshipped_cancel' },
        '用户重复申请退款',
      ),
      final(
        '该订单此前已完成过售后退款 不能重复申请 如有新的问题请联系人工客服核实',
        '重复申请冲突拦截',
      ),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'refunds',
          where: { order_no: 'SO-2026-0008' },
          field: 'refund_no',
          op: 'count',
          value: 1,
        },
      ],
      trajectory: { forbiddenTools: ['execute_refund'] },
      expectGatewayCharges: 0,
    },
  },
  {
    id: 'rj_refund_only_without_goods_return',
    category: 'rejection',
    priority: 'P1',
    description: '已签收订单要求不退货仅退款 意图槽位被契约拒绝 不产生售后单',
    actor: { role: 'customer', customerId: 'C1001' },
    turns: [{ userMessage: '订单 SO-2026-0003 已经签收了 但是我不想退回去 直接退钱就行' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action(
        'submit_refund_only',
        { orderNo: 'SO-2026-0003', reason: 'no_reason' },
        '已签收仅退款不退货',
      ),
      final(
        '已签收订单需要先退货才能退款 暂不支持不退货仅退款 如您选择退货我可以为您创建退货单',
        '槽位契约拒绝',
      ),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'return_requests',
          where: { return_no: NEW_RETURN_NO },
          field: 'return_no',
          op: 'missing',
        },
      ],
      trajectory: { forbiddenTools: ['execute_refund'] },
      expectGatewayCharges: 0,
    },
  },
]
