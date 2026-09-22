/**
 * 人工接管用例 escalated 会话的收口闭环
 *
 * AI 升级人工后坐席接管 对话与标记解决 escalated 不再是死终态
 * 拒绝面 未升级不可接管 未接管不可发消息 客户不可接管 重复接管幂等拒绝
 */

import type { EvalCaseInput } from '@aftersales/contracts'
import { action, final, runStatus } from './helpers.js'

export const handoverCases: EvalCaseInput[] = [
  {
    id: 'hd_take_over_and_resolve',
    category: 'handover',
    priority: 'P0',
    description: '客户坚持只与真人对话 AI 无条件升级后坐席接管 对话并标记解决 会话回到 completed',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'impatient',
      personaNotes: '不信任机器人 只接受真人处理',
      reasonForContact: '订单 SO-2026-0003 想退货 但坚决不与机器人沟通',
      known: ['订单号 SO-2026-0003', '此前有过不愉快的机器人客服经历'],
      instructions:
        '坚持只与真人客服对话 拒绝向机器人提供任何信息或配合任何流程 直到真人接入并给出处理后结束',
      maxTurns: 4,
    },
    turns: [{ userMessage: '订单 SO-2026-0003 我不跟机器人说话 给我转人工 否则我去投诉' }],
    modelScript: [
      action('escalate', { reason: '客户坚决要求人工拒绝机器人沟通' }, '无条件升级人工'),
    ],
    handoverScript: [
      { action: 'take_over' },
      {
        action: 'operator_message',
        message: '您好 我是人工坐席 已了解您的情况 这就为您核实订单',
      },
      {
        action: 'resolve',
        summary: '已向客户解释七天无理由退货政策边界 建议走质保通道 会话解决',
      },
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'run.handover' },
          field: 'id',
          op: 'exists',
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'operator.message' },
          field: 'payload_json',
          op: 'contains',
          value: '人工坐席',
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'run.resolved' },
          field: 'payload_json',
          op: 'contains',
          value: '七天无理由',
        },
        { table: 'audit_logs', where: { action: 'run_handover_taken' }, field: 'id', op: 'exists' },
        { table: 'audit_logs', where: { action: 'run_resolved' }, field: 'id', op: 'exists' },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'run.escalated' },
          field: 'id',
          op: 'exists',
          note: '升级发生过 终态经坐席解决回到 completed',
        },
      ],
    },
  },
  {
    id: 'hd_customer_reply_during_handling',
    category: 'handover',
    priority: 'P0',
    description: '人工处理中客户继续留言 双向对话成立 客户消息落事件流',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'impatient',
      personaNotes: '被机器人惹恼 只肯跟真人说话',
      reasonForContact: '订单 SO-2026-0003 退货被拒 坚持转人工',
      known: ['订单号 SO-2026-0003'],
      instructions: '坚持要人工 真人接入后补充说明诉求 得到结论后结束',
      maxTurns: 4,
    },
    turns: [{ userMessage: '订单 SO-2026-0003 我要退货 你们机器人别应付我 转人工' }],
    modelScript: [action('escalate', { reason: '客户明确要求人工' }, '升级人工处理')],
    handoverScript: [
      { action: 'take_over' },
      { action: 'operator_message', message: '您好 我是人工坐席 请讲 您的具体诉求是什么' },
      { action: 'customer_message', message: '键盘有一个键失灵了 我要退货' },
      { action: 'resolve', summary: '坐席核实质量问题 走质保换新流程 会话解决' },
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'message.user' },
          field: 'id',
          op: 'exists',
          note: '首回合与人工处理中的客户留言均在事件流',
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'operator.message' },
          field: 'id',
          op: 'exists',
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'run.resolved' },
          field: 'payload_json',
          op: 'contains',
          value: '质保',
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'run.escalated' },
          field: 'id',
          op: 'exists',
          note: '升级发生过 终态经坐席解决回到 completed',
        },
      ],
    },
  },
  {
    id: 'hd_take_over_rejected_when_not_escalated',
    category: 'handover',
    priority: 'P1',
    description: '未升级的普通会话不可接管 completed 会话接管被拒 状态与事件不变',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '咨询退货政策',
      known: ['无具体订单问题'],
      instructions: '咨询政策得到答复后结束',
      maxTurns: 3,
    },
    turns: [{ userMessage: '退货政策是什么' }],
    modelScript: [final('签收后七天内可无理由退货 生鲜与定制品除外', '政策咨询')],
    handoverScript: [{ action: 'take_over' }],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'run.handover' },
          field: 'id',
          op: 'missing',
          note: '未升级的会话接管被拒 无接管事件',
        },
        {
          table: 'audit_logs',
          where: { action: 'run_handover_taken' },
          field: 'id',
          op: 'missing',
        },
      ],
    },
  },
  {
    id: 'hd_message_requires_handling',
    category: 'handover',
    priority: 'P1',
    description: '坐席在接管前发消息被拒 escalated 会话无坐席消息 状态保持升级终态',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'impatient',
      reasonForContact: '订单 SO-2026-0003 退货被拒 坚持转人工',
      known: ['订单号 SO-2026-0003'],
      instructions: '要求转人工 不接受机器人方案',
      maxTurns: 4,
    },
    turns: [{ userMessage: '订单 SO-2026-0003 我要退货 不行就转人工' }],
    modelScript: [action('escalate', { reason: '客户坚持要求人工' }, '升级人工处理')],
    handoverScript: [
      {
        action: 'operator_message',
        message: '未接管先发消息 应被拒绝',
      },
    ],
    assertions: {
      expectedState: [
        runStatus('escalated'),
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'operator.message' },
          field: 'id',
          op: 'count',
          value: 0,
          note: '接管前的坐席消息被拒 不落事件',
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'run.handover' },
          field: 'id',
          op: 'missing',
        },
      ],
      expectEscalation: true,
    },
  },
  {
    id: 'hd_customer_cannot_take_over',
    category: 'handover',
    priority: 'P1',
    description: '客户身份尝试接管被领域角色防线拒绝 会话保持升级等待坐席',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'impatient',
      reasonForContact: '订单 SO-2026-0003 退货被拒 坚持转人工',
      known: ['订单号 SO-2026-0003'],
      instructions: '要求转人工 不接受机器人方案',
      maxTurns: 4,
    },
    turns: [{ userMessage: '订单 SO-2026-0003 转人工 我要真人处理' }],
    modelScript: [action('escalate', { reason: '客户明确要求人工' }, '升级人工处理')],
    handoverScript: [{ action: 'take_over', role: 'customer' }],
    assertions: {
      expectedState: [
        runStatus('escalated'),
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'run.handover' },
          field: 'id',
          op: 'missing',
          note: '客户接管被领域角色防线拒绝',
        },
        {
          table: 'audit_logs',
          where: { action: 'run_handover_taken' },
          field: 'id',
          op: 'missing',
        },
      ],
      expectEscalation: true,
    },
  },
  {
    id: 'hd_duplicate_take_over_rejected',
    category: 'handover',
    priority: 'P2',
    description: '重复接管被拒 接管事件与审计只落一次 最终仍可标记解决',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'impatient',
      reasonForContact: '订单 SO-2026-0003 退货被拒 坚持转人工',
      known: ['订单号 SO-2026-0003'],
      instructions: '要求转人工 真人接入并给出结论后结束',
      maxTurns: 4,
    },
    turns: [{ userMessage: '订单 SO-2026-0003 我要退货 转人工处理' }],
    modelScript: [action('escalate', { reason: '客户坚持要求人工' }, '升级人工处理')],
    handoverScript: [
      { action: 'take_over' },
      { action: 'take_over' },
      {
        action: 'resolve',
        summary: '坐席解释政策边界 重复接管被幂等拒绝 会话解决',
      },
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'run.handover' },
          field: 'id',
          op: 'count',
          value: 1,
          note: '重复接管被拒 接管事件只有一条',
        },
        {
          table: 'audit_logs',
          where: { action: 'run_handover_taken' },
          field: 'id',
          op: 'count',
          value: 1,
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'run.resolved' },
          field: 'payload_json',
          op: 'contains',
          value: '幂等拒绝',
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'run.escalated' },
          field: 'id',
          op: 'exists',
          note: '升级发生过 终态经坐席解决回到 completed',
        },
      ],
    },
  },
]
