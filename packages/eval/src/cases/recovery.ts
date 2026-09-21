/**
 * 恢复与幂等用例 进程中断恢复 重复提交拦截 完整退货闭环
 */

import type { EvalCaseInput } from '@aftersales/contracts'
import { NEW_RETURN_NO, action, final, runStatus, toolCall } from './helpers.js'

export const recoveryCases: EvalCaseInput[] = [
  {
    id: 'rec_crash_resume_no_double_refund',
    category: 'recovery',
    priority: 'P0',
    description: '退款执行中进程中断 断点恢复后完成且网关只扣款一次',
    actor: { role: 'customer', customerId: 'C1002' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0009 一直不发货 不想要了 要求退款',
      known: ['订单号 SO-2026-0009', '下单后没收到发货通知', '微信支付'],
      instructions: '要求仅退款 若处理稍慢也耐心等待 不重复催办 确认退款已办理且原路退回即结束',
    },
    turns: [{ userMessage: '订单 SO-2026-0009 不要了 退款' }],
    faultPlan: [{ tool: 'execute_refund', fault: 'crash', times: 1 }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0009' }),
      action(
        'submit_refund_only',
        { orderNo: 'SO-2026-0009', reason: 'unshipped_cancel' },
        '未发货仅退款',
      ),
      final('退款已办理完成 89 元将原路退回', '中断恢复后退款完成'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'refunds',
          where: { return_no: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'succeeded',
        },
        {
          table: 'agent_events',
          where: { type: 'step.started' },
          field: 'payload_json',
          op: 'contains',
          value: '"stepId":"create_return"',
          note: '已完成步骤不允许二次执行',
        },
        {
          table: 'refunds',
          where: { return_no: NEW_RETURN_NO },
          field: 'id',
          op: 'count',
          value: 1,
        },
      ],
      expectGatewayCharges: 1,
      communicateInfo: ['原路'],
      judgeRubric: ['确认退款完成且未重复发起申请'],
    },
  },
  {
    id: 'rec_duplicate_request_blocked',
    category: 'recovery',
    priority: 'P0',
    description: '弱模型同一回合重复发起退款 冲突拦截只产生一笔',
    actor: { role: 'customer', customerId: 'C1002' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0009 不想要了 要求退款 想多操作一次确保到账',
      known: ['订单号 SO-2026-0009', '没收到发货通知', '担心一次操作不成功钱不到账'],
      instructions:
        '要求退款并主动请对方操作两次确保到账 若对方解释重复提交会被系统拦截无需重复操作 接受解释即结束',
    },
    turns: [{ userMessage: '订单 SO-2026-0009 退款 最好操作两次确保到账' }],
    modelScript: [
      action(
        'submit_refund_only',
        { orderNo: 'SO-2026-0009', reason: 'unshipped_cancel' },
        '第一次退款',
      ),
      action(
        'submit_refund_only',
        { orderNo: 'SO-2026-0009', reason: 'unshipped_cancel' },
        '用户要求再操作一次确保到账',
      ),
      final('退款已成功办理 无需重复操作 重复提交会被系统拦截 89 元将原路退回', '重复提交被拦截'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'refunds',
          where: { order_no: 'SO-2026-0009' },
          field: 'refund_no',
          op: 'count',
          value: 1,
        },
        {
          table: 'refunds',
          where: { order_no: 'SO-2026-0009' },
          field: 'status',
          op: 'eq',
          value: 'succeeded',
        },
      ],
      expectGatewayCharges: 1,
      communicateInfo: ['原路'],
      judgeRubric: ['解释了无需重复操作的原因 未按客户要求重复提交'],
    },
  },
  {
    id: 'rec_return_full_loop',
    category: 'recovery',
    priority: 'P0',
    description: '退货全闭环 创建 寄回 收货 联动退款一次完成',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0003 的机械键盘不想要了 走七天无理由退货',
      known: ['订单号 SO-2026-0003', '签收没几天 键盘完好不影响二次销售', '愿意之后寄回商品'],
      instructions:
        '申请七天无理由退货 确认退货单已创建并知道寄回后收货才退款即结束 对话结束后会寄出商品',
    },
    turns: [{ userMessage: '订单 SO-2026-0003 七天无理由退货' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action('submit_return', { orderNo: 'SO-2026-0003', reason: 'no_reason' }, '无理由退货'),
      final('退货单已创建 请寄回商品 寄回后我们收货即退款', '退货单创建'),
    ],
    operatorActions: [
      {
        tool: 'record_return_shipment',
        args: { returnNo: NEW_RETURN_NO, trackingNo: 'SF-RETURN-1001' },
        role: 'customer',
      },
      { tool: 'receive_return_goods', args: { returnNo: NEW_RETURN_NO }, role: 'operator' },
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
          table: 'audit_logs',
          where: { action: 'return_goods_received' },
          field: 'id',
          op: 'exists',
        },
      ],
      trajectory: {
        requiredTools: [
          'get_order',
          'create_return_request',
          'record_return_shipment',
          'receive_return_goods',
        ],
        orderedSubsequence: [
          'create_return_request',
          'record_return_shipment',
          'receive_return_goods',
        ],
      },
      expectGatewayCharges: 1,
      communicateInfo: ['寄回'],
      judgeRubric: ['说明了寄回后收货才退款的顺序'],
    },
  },
  {
    id: 'rec_exchange_full_loop',
    category: 'recovery',
    priority: 'P1',
    description: '换货全闭环 收货后完结重发 不产生退款',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0003 的键盘有质量问题 要求换货',
      known: ['订单号 SO-2026-0003', '键盘按键有质量问题', '签收没几天', '愿意之后寄回商品'],
      instructions:
        '要求换货不要退款 确认换货单已创建且知道寄回后会重发新商品即结束 对话结束后会寄出商品',
    },
    turns: [{ userMessage: '订单 SO-2026-0003 质量问题 换货' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action('submit_exchange', { orderNo: 'SO-2026-0003', reason: 'quality' }, '质量问题换货'),
      final('换货单已创建 寄回商品收到后为您重发', '换货单创建'),
    ],
    operatorActions: [
      {
        tool: 'record_return_shipment',
        args: { returnNo: NEW_RETURN_NO, trackingNo: 'SF-RETURN-1002' },
        role: 'customer',
      },
      { tool: 'receive_return_goods', args: { returnNo: NEW_RETURN_NO }, role: 'operator' },
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
        { table: 'audit_logs', where: { action: 'exchange_completed' }, field: 'id', op: 'exists' },
      ],
      trajectory: {
        requiredTools: ['create_return_request', 'receive_return_goods'],
      },
      expectGatewayCharges: 0,
      communicateInfo: ['换货', '寄回'],
      judgeRubric: ['说明了寄回后重发的换货流程'],
    },
  },
]
