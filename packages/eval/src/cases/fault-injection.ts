/**
 * 故障注入用例 工具超时 限流 上游故障 脏数据
 */

import type { EvalCaseInput } from '@aftersales/contracts'
import { escalate, final, runStatus, toolCall } from './helpers.js'

export const faultInjectionCases: EvalCaseInput[] = [
  {
    id: 'fi_tool_timeout_retry',
    category: 'fault_injection',
    priority: 'P0',
    description: '工具超时一次 退避重试后成功 任务正常完成',
    actor: { role: 'customer', customerId: 'C1001' },
    turns: [{ userMessage: '帮我看看订单 SO-2026-0002 到哪了' }],
    faultPlan: [{ tool: 'get_order', fault: 'timeout', times: 1 }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0002' }),
      final('您的订单在运输途中 预计两天内送达', '超时重试后查单完成'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'tool_executions',
          where: { tool_name: 'get_order' },
          field: 'id',
          op: 'count',
          value: 2,
        },
        {
          table: 'tool_executions',
          where: { tool_name: 'get_order', error_code: 'TIMEOUT' },
          field: 'id',
          op: 'count',
          value: 1,
        },
      ],
    },
  },
  {
    id: 'fi_rate_limited_retry',
    category: 'fault_injection',
    priority: 'P0',
    description: '渠道限流一次 退避重试成功',
    actor: { role: 'customer', customerId: 'C1001' },
    turns: [{ userMessage: '查一下订单 SO-2026-0002' }],
    faultPlan: [{ tool: 'get_order', fault: 'rate_limited', times: 1 }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0002' }),
      final('订单已发货 运输中', '限流重试后完成'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'tool_executions',
          where: { tool_name: 'get_order', error_code: 'RATE_LIMITED' },
          field: 'id',
          op: 'count',
          value: 1,
        },
      ],
    },
  },
  {
    id: 'fi_server_error_escalate',
    category: 'fault_injection',
    priority: 'P1',
    description: '上游持续故障 重试耗尽后升级人工',
    actor: { role: 'customer', customerId: 'C1001' },
    turns: [{ userMessage: '帮我查下订单 SO-2026-0002' }],
    faultPlan: [{ tool: 'get_order', fault: 'server_error', times: 5 }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0002' }),
      escalate('订单系统持续异常 无法完成查询'),
    ],
    assertions: {
      expectedState: [
        {
          table: 'agent_runs',
          where: { run_id: '@runId' },
          field: 'status',
          op: 'eq',
          value: 'escalated',
        },
        {
          table: 'tool_executions',
          where: { tool_name: 'get_order' },
          field: 'id',
          op: 'count',
          value: 2,
        },
        {
          table: 'tool_executions',
          where: { tool_name: 'get_order' },
          field: 'status',
          op: 'ne',
          value: 'succeeded',
        },
      ],
      expectEscalation: true,
    },
  },
  {
    id: 'fi_dirty_data_missing_shipment',
    category: 'fault_injection',
    priority: 'P2',
    description: '订单无物流记录 工具返回未找到 Agent 如实解释',
    actor: { role: 'customer', customerId: 'C1001' },
    turns: [{ userMessage: '订单 SO-2026-0001 发货了吗 物流单号多少' }],
    modelScript: [
      toolCall('get_shipment', { orderNo: 'SO-2026-0001' }),
      final('该订单尚未发货 暂无物流信息 请留意发货通知', '无物流记录如实解释'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'tool_executions',
          where: { tool_name: 'get_shipment', error_code: 'NOT_FOUND' },
          field: 'id',
          op: 'count',
          value: 1,
        },
      ],
    },
  },
]
