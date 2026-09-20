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

/** 用例执行明细 供指标分层统计 */
export interface CaseDetail {
  caseId: string
  category: string
  priority: 'P0' | 'P1' | 'P2'
  passed: boolean
  failures: string[]
  durationMs: number
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
