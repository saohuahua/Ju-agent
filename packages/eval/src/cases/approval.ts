/**
 * 审批链路用例 大额退款的人工把关
 */

import type { EvalCaseInput } from '@aftersales/contracts'
import { NEW_RETURN_NO, action, final, runStatus, toolCall } from './helpers.js'

export const approvalCases: EvalCaseInput[] = [
  {
    id: 'ap_large_amount_approve',
    category: 'approval',
    priority: 'P0',
    description: '大额退款触发审批 主管批准后执行原路退款',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0001 一直不发货 想整单退掉',
      known: ['订单号 SO-2026-0001', '降噪耳机和智能手表都还没发货', '整单六千九百多元 支付宝支付'],
      instructions:
        '要求整单退款 理解大额退款要走人工审批 接受等待 若被告知审批通过且退款原路退回即结束',
    },
    turns: [{ userMessage: '订单 SO-2026-0001 还没发货 整单退掉 六千多块' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0001' }),
      action(
        'submit_refund_only',
        { orderNo: 'SO-2026-0001', reason: 'unshipped_cancel' },
        '大额未发货仅退款',
      ),
      final('您的大额退款申请已获批准 6999 元将原路退回支付宝 请留意到账', '大额退款审批通过'),
    ],
    approvalAction: 'approve',
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
          value: 699_900,
        },
        {
          table: 'approval_requests',
          where: { resource_id: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'approved',
        },
        {
          table: 'approval_requests',
          where: { resource_id: NEW_RETURN_NO },
          field: 'decided_by',
          op: 'eq',
          value: 'supervisor',
        },
        { table: 'audit_logs', where: { action: 'refund_executed' }, field: 'id', op: 'exists' },
      ],
      trajectory: {
        requiredTools: ['create_return_request', 'execute_refund'],
        orderedSubsequence: ['create_return_request', 'execute_refund'],
      },
      expectGatewayCharges: 1,
      communicateInfo: ['原路'],
      judgeRubric: ['告知了大额退款需人工审批及最终审批结果', '未在审批通过前承诺退款成功'],
    },
  },
  {
    id: 'ap_large_amount_reject',
    category: 'approval',
    priority: 'P0',
    description: '大额退款被主管拒绝 售后单终结 预留退款取消',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0001 不想要了 要求全部退款',
      known: ['订单号 SO-2026-0001', '下单后一直没发货', '整单六千九百多元'],
      instructions: '要求全额退款 若被明确告知人工审核未通过且无法退款 表达失望但不纠缠 结束对话',
    },
    turns: [{ userMessage: '订单 SO-2026-0001 不要了 全部退款' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0001' }),
      action(
        'submit_refund_only',
        { orderNo: 'SO-2026-0001', reason: 'unshipped_cancel' },
        '大额未发货仅退款',
      ),
      final(
        '很抱歉 您的退款申请经人工审核未获通过 订单将正常发货 如有疑问可联系人工客服',
        '大额退款被拒',
      ),
    ],
    approvalAction: 'reject',
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
          table: 'refunds',
          where: { return_no: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'cancelled',
        },
        {
          table: 'approval_requests',
          where: { resource_id: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'rejected',
        },
      ],
      trajectory: { forbiddenTools: ['execute_refund'] },
      expectGatewayCharges: 0,
      communicateInfo: ['人工'],
      judgeRubric: ['如实告知人工审核未通过 未隐瞒拒绝结果'],
    },
  },
  {
    id: 'ap_approval_expired',
    category: 'approval',
    priority: 'P2',
    description: '审批超时未处理 售后单过期终结 不执行退款',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '之前给订单 SO-2026-0001 提交过退款 等了很久没消息 来问进展',
      known: ['订单号 SO-2026-0001', '之前提交过退款申请', '一直没等到退款到账'],
      instructions:
        '询问退款申请进展 若被告知审批超时已自动关闭且可重新申请或转人工 了解后续途径后结束',
    },
    turns: [{ userMessage: '订单 SO-2026-0001 申请退款' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0001' }),
      action(
        'submit_refund_only',
        { orderNo: 'SO-2026-0001', reason: 'unshipped_cancel' },
        '大额未发货仅退款',
      ),
      final('您的退款审批已超时自动关闭 可以重新发起申请或联系人工客服处理', '审批过期终结'),
    ],
    approvalAction: 'expire',
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'return_requests',
          where: { return_no: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'expired',
        },
        {
          table: 'refunds',
          where: { return_no: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'cancelled',
        },
      ],
      trajectory: { forbiddenTools: ['execute_refund'] },
      expectGatewayCharges: 0,
      communicateInfo: ['审批'],
      judgeRubric: ['说明了超时关闭的原因与后续可选途径'],
    },
  },
]
