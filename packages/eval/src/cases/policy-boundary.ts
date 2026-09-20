/**
 * 政策边界用例 时限 类目 部分退款 金额计算
 */

import type { EvalCaseInput } from '@aftersales/contracts'
import { NEW_RETURN_NO, action, final, runStatus, toolCall } from './helpers.js'

export const policyBoundaryCases: EvalCaseInput[] = [
  {
    id: 'pb_over_7d_no_reason',
    category: 'policy_boundary',
    priority: 'P0',
    description: '签收超过七天 无理由退货被政策拒绝',
    actor: { role: 'customer', customerId: 'C1003' },
    turns: [{ userMessage: '订单 SO-2026-0005 不想要了 退货退款' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0005' }),
      action(
        'submit_return',
        { orderNo: 'SO-2026-0005', reason: 'no_reason' },
        '用户申请无理由退货',
      ),
      final(
        '很抱歉 该订单签收已超过七天 不在无理由退货窗口内 如有特殊原因可为您转人工核实',
        '超时无理由拒绝',
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
          value: 'R4_no_reason_7d',
        },
        {
          table: 'refunds',
          where: { return_no: NEW_RETURN_NO },
          field: 'refund_no',
          op: 'missing',
        },
      ],
      trajectory: {
        forbiddenTools: ['execute_refund'],
      },
      expectGatewayCharges: 0,
    },
  },
  {
    id: 'pb_fresh_food_no_reason',
    category: 'policy_boundary',
    priority: 'P1',
    description: '生鲜类目不支持七天无理由 被政策拒绝',
    actor: { role: 'customer', customerId: 'C1002' },
    turns: [{ userMessage: '订单 SO-2026-0006 的车厘子没吃完 想退掉' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0006' }),
      action(
        'submit_return',
        { orderNo: 'SO-2026-0006', reason: 'no_reason' },
        '用户申请无理由退货',
      ),
      final(
        '生鲜类商品不支持七天无理由退货 无法为您办理 如商品有质量问题可以重新提交质量问题售后',
        '生鲜类目拒绝',
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
      ],
      trajectory: { forbiddenTools: ['execute_refund'] },
      expectGatewayCharges: 0,
    },
  },
  {
    id: 'pb_customized_overdue',
    category: 'policy_boundary',
    priority: 'P2',
    description: '定制商品且超七天 无理由退货双重不满足',
    actor: { role: 'customer', customerId: 'C1001' },
    turns: [{ userMessage: '订单 SO-2026-0007 的书桌不合适 退货' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0007' }),
      action(
        'submit_return',
        { orderNo: 'SO-2026-0007', reason: 'no_reason' },
        '用户申请无理由退货',
      ),
      final(
        '定制商品不支持无理由退货 且已超过七天窗口 无法在线办理 如有质量问题可转人工核实',
        '定制类目拒绝',
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
      ],
      expectGatewayCharges: 0,
    },
  },
  {
    id: 'pb_quality_boundary_15d',
    category: 'policy_boundary',
    priority: 'P1',
    description: '质量问题恰好第 15 天 边界值内允许退换',
    actor: { role: 'customer', customerId: 'C1002' },
    turns: [{ userMessage: '订单 SO-2026-0004 的保温杯用了两周发现漏水 质量问题退货' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0004' }),
      action(
        'submit_return',
        { orderNo: 'SO-2026-0004', reason: 'quality' },
        '签收第 15 天质量问题',
      ),
      final(
        '质量问题在 15 天受理窗口内 售后单已创建 寄回商品后全额退款 运费由我们承担',
        '质量边界内受理',
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
          table: 'return_requests',
          where: { return_no: NEW_RETURN_NO },
          field: 'refund_amount_cents',
          op: 'eq',
          value: 45_900,
        },
      ],
      expectGatewayCharges: 0,
    },
  },
  {
    id: 'pb_partial_refund_amount',
    category: 'policy_boundary',
    priority: 'P1',
    description: '部分退货 按选中商品小计计算退款金额',
    actor: { role: 'customer', customerId: 'C1001' },
    turns: [{ userMessage: '订单 SO-2026-0003 里键帽套装不要了 只退这一个' }],
    fixturePatch: [
      {
        table: 'orders',
        where: { order_no: 'SO-2026-0003' },
        set: {
          items_json:
            '[{"itemId":"item-0003-1","sku":"SKU-KB-001","title":"机械键盘","category":"electronics","quantity":1,"unitPriceCents":89900},{"itemId":"item-0003-2","sku":"SKU-KB-002","title":"键帽套装","category":"electronics","quantity":2,"unitPriceCents":3900}]',
        },
      },
    ],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action(
        'submit_return',
        { orderNo: 'SO-2026-0003', reason: 'no_reason', itemIds: ['item-0003-2'] },
        '仅退部分商品',
      ),
      final('已按部分退货创建售后单 退款金额 78 元 寄回键帽套装后原路退回', '部分退货金额计算'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'return_requests',
          where: { return_no: NEW_RETURN_NO },
          field: 'refund_amount_cents',
          op: 'eq',
          value: 7_800,
        },
        {
          table: 'refunds',
          where: { return_no: NEW_RETURN_NO },
          field: 'amount_cents',
          op: 'eq',
          value: 7_800,
        },
      ],
      trajectory: {
        toolArgs: [
          { tool: 'create_return_request', argPath: 'itemIds.0', op: 'eq', value: 'item-0003-2' },
        ],
      },
      expectGatewayCharges: 0,
    },
  },
]
