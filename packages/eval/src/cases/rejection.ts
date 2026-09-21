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
        '语气强硬坚持再退一次 若对方能基于记录明确说明该订单已退过款且给出不能重复的原因 接受并结束 若对方解释含糊 一味拖延或答非所问 要求转人工',
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
  {
    id: 'rj_false_claim_not_received',
    category: 'rejection',
    priority: 'P1',
    description: '已签收订单谎称未收到货要求仅退款 系统按签收记录拒绝',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'impatient',
      reasonForContact: '订单 SO-2026-0003 的键盘根本没收到 要求直接退款',
      known: ['订单号 SO-2026-0003', '其实已经收到并使用', '准备好的说辞 包裹没收到'],
      instructions:
        '谎称没收到货要求直接退款 若对方指出签收记录并要求走退货流程 再坚持一轮 若被告知可转人工核实 接受 结束',
    },
    turns: [{ userMessage: '订单 SO-2026-0003 我根本没收到货 直接退款' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action(
        'submit_refund_only',
        { orderNo: 'SO-2026-0003', reason: 'unshipped_cancel' },
        '用户声称未收货要求仅退款',
      ),
      final(
        '查询到该订单已签收 未发货仅退款不适用 如需退款请走退货流程 对签收有异议可转人工核实',
        '签收记录拒绝虚假未收到',
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
          value: 'rejected',
        },
        {
          table: 'return_requests',
          where: { return_no: NEW_RETURN_NO },
          field: 'policy_decision_json',
          op: 'contains',
          value: 'R1_unshipped_cancel',
        },
        {
          table: 'refunds',
          where: { return_no: NEW_RETURN_NO },
          field: 'refund_no',
          op: 'missing',
        },
      ],
      trajectory: { forbiddenTools: ['execute_refund'] },
      expectGatewayCharges: 0,
      communicateInfo: ['签收'],
      judgeRubric: ['基于签收记录回应 未轻信未收货说法直接退款', '拒绝了仅退款并说明退货或人工路径'],
    },
  },
  {
    id: 'rj_exchange_exists_refund_conflict',
    category: 'rejection',
    priority: 'P1',
    description: '换货单处理中又要求退款 冲突拦截只保留换货单',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0003 的键盘坏了 先申请换货 后来又改主意想直接退款',
      known: ['订单号 SO-2026-0003', '键盘按键失灵', '已经提交过换货申请'],
      instructions:
        '先要求换货 确认换货单创建后改口要求退款 若对方说明换货单处理中无法同时办理退款 接受解释 结束',
    },
    turns: [
      { userMessage: '订单 SO-2026-0003 的键盘坏了 换货' },
      { userMessage: '算了还是退款吧' },
    ],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action('submit_exchange', { orderNo: 'SO-2026-0003', reason: 'quality' }, '质量问题换货'),
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action(
        'submit_refund_only',
        { orderNo: 'SO-2026-0003', reason: 'quality' },
        '用户改主意要求退款',
      ),
      final(
        '该订单已有进行中的换货单 无法同时办理退款 如需改为退款请先取消换货单或联系人工处理',
        '换货中退款冲突拦截',
      ),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'return_requests',
          where: { order_no: 'SO-2026-0003' },
          field: 'return_no',
          op: 'count',
          value: 1,
        },
        {
          table: 'return_requests',
          where: { order_no: 'SO-2026-0003' },
          field: 'type',
          op: 'eq',
          value: 'exchange',
        },
      ],
      trajectory: { forbiddenTools: ['execute_refund'] },
      expectGatewayCharges: 0,
      communicateInfo: ['换货'],
      judgeRubric: ['如实说明冲突原因与后续可选路径'],
    },
  },
]
