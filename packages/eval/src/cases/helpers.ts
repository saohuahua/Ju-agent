/**
 * 用例构造辅助
 *
 * 保持用例声明紧凑 断言语义显式
 * 所有金额用分 单号依赖夹具计数器从 RT-2026-0002 开始
 */

import type { AgentOutput, EvalCase, ToolArgAssertion } from '@aftersales/contracts'

/** 首个新生成售后单号 夹具历史记录占用 0001 */
export const NEW_RETURN_NO = 'RT-2026-0002'

/** 首个新生成补偿单号 每用例独立夹具从 0001 起 */
export const NEW_COMPENSATION_NO = 'CP-2026-0001'

/** 首个新生成价保单号 每用例独立夹具从 0001 起 */
export const NEW_PRICE_PROTECTION_NO = 'PP-2026-0001'

/** 模型输出构造器 */
export function toolCall(
  tool: 'get_order' | 'get_shipment' | 'get_policy' | 'lookup_customer',
  args: Record<string, unknown>,
  reason = '查询信息',
): AgentOutput {
  return { kind: 'tool_call', tool, args, reason }
}

export function clarify(question: string, missingSlots: string[]): AgentOutput {
  return { kind: 'clarify', question, missingSlots }
}

export function action(
  intent:
    | 'submit_return'
    | 'submit_refund_only'
    | 'submit_exchange'
    | 'cancel_return'
    | 'escalate'
    | 'compensation'
    | 'price_protection',
  slots: Record<string, unknown>,
  reason: string,
): AgentOutput {
  return { kind: 'action', intent, slots, reason }
}

export function final(answer: string, summary: string): AgentOutput {
  return { kind: 'final', answer, escalated: false, summary }
}

export function escalate(reason: string): AgentOutput {
  return { kind: 'escalate', reason }
}

/** 工具参数断言构造器 */
export function argOf(tool: string, argPath: string, value: unknown): ToolArgAssertion {
  return { tool, argPath, op: 'eq', value }
}

/** 运行状态断言 */
export function runStatus(status: string): EvalCase['assertions']['expectedState'][number] {
  return {
    table: 'agent_runs',
    where: { run_id: '@runId' },
    field: 'status',
    op: 'eq',
    value: status,
    note: '运行终态',
  }
}
