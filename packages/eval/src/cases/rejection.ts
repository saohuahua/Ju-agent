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
    scenario: {
      persona: 'impatient',
      reasonForContact: '订单 SO-2026-0008 上个月退过一次款 现在想再退一次',
      known: ['订单号 SO-2026-0008', '这个订单之前退过一次款', '想再申请一次退款'],
      instructions:
        '语气强硬坚持再退一次 若对方明确说明该订单已完成过售后无法重复申请 催促一两次无果后接受转人工建议 结束',
    },
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
      communicateInfo: ['人工'],
      judgeRubric: ['如实告知已完成过售后退款 未编造可再次退款的说法'],
    },
  },
  {
    id: 'rj_refund_only_without_goods_return',
    category: 'rejection',
    priority: 'P1',
    description: '已签收订单要求不退货仅退款 意图槽位被契约拒绝 不产生售后单',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'impatient',
      reasonForContact: '订单 SO-2026-0003 的键盘已签收 但不想寄回 想直接拿回钱',
      known: ['订单号 SO-2026-0003', '键盘已签收在自己手里', '不想寄回商品 只想直接退款'],
      instructions:
        '强硬要求不退货直接退款 坚持一两轮 若对方明确解释必须先退货才能退款 表示要再考虑 当场不确认创建退货单 结束对话',
    },
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
      communicateInfo: ['退货', '签收'],
      judgeRubric: ['明确说明已签收订单须先退货才能退款 未妥协办理仅退款'],
    },
  },
]
