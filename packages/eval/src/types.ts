/**
 * 评测内部类型
 */

export interface ToolExecution {
  toolName: string
  args: Record<string, unknown>
  status: 'succeeded' | 'failed'
  errorCode: string | null
  attempt: number
}

/** L2 用户模拟的 judge 判定失败项 */
export interface JudgeFailure {
  rubric: string
  reason: string
}

/** 用例执行明细 供指标分层统计 */
export interface CaseDetail {
  caseId: string
  category: string
  priority: 'P0' | 'P1' | 'P2'
  passed: boolean
  failures: string[]
  durationMs: number
  /** L2 用户模拟对话轮次 */
  turns?: number
  /** L2 被测 Agent token 与成本 */
  agentInputTokens?: number
  agentOutputTokens?: number
  agentCostUsd?: number
  /** L2 用户模拟器 token 与成本 */
  simulatorInputTokens?: number
  simulatorOutputTokens?: number
  simulatorCostUsd?: number
  /** L2 judge 失败项 */
  judge?: JudgeFailure[]
  /** L2 事件序列号 供 transcript 回放 */
  runId?: string
  /** 分层通过标记 与指标键对应 */
  layer: {
    stateOk: boolean
    trajectoryOk: boolean
    argsOk: boolean
    escalationOk: boolean
    clarifyOk: boolean
    gatewayOk: boolean
  }
}
