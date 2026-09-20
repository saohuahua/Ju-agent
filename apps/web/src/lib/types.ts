/**
 * 前端本地类型
 *
 * 前端只依赖 HTTP 契约 不导入工作区包 保持部署解耦
 * 字段与 packages/contracts 中的 schema 一致 修改时两侧同步
 */

export type RunStatus =
  | 'created'
  | 'running'
  | 'awaiting_input'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'escalated'

export interface AgentEvent {
  runId: string
  sequence: number
  type: string
  payload: Record<string, unknown>
  createdAt: string
}

export interface RunSummary {
  runId: string
  customerId: string
  status: RunStatus
  intent: string | null
  promptVersion: string
  model: string
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface ApprovalRequest {
  approvalId: string
  runId: string | null
  resourceType: string
  resourceId: string
  reason: string
  amountCents: number
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  expiresAt: string
  createdAt: string
}

export interface EvalReportSummary {
  reportId: string
  startedAt: string
  model: string
  promptVersion: string
  total: number
  passed: number
  failed: number
  gatePassed: boolean
  report: {
    metrics?: Record<string, number>
    byCategory?: Record<string, { total: number; passed: number }>
    passPowerK?: number
  }
}
