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
  | 'handling_human'

export interface AgentEvent {
  runId: string
  sequence: number
  type: string
  payload: Record<string, unknown>
  createdAt: string
}

/** 与订单候选公开事件契约一致 */
export interface OrderCandidates {
  orders: Array<{
    orderNo: string
    status: string
    totalAmountCents: number
    currency: string
    createdAt: string
    items: Array<{ itemId: string; title: string; quantity: number }>
  }>
  offset: number
  nextOffset: number | null
}

export interface RunSummary {
  runId: string
  customerId: string
  status: RunStatus
  intent: string | null
  promptVersion: string
  model: string
  error: string | null
  /** 会话来源 customer 真实客户 sim 评测与模拟 运营指标只聚合前者 */
  source: 'customer' | 'sim'
  createdAt: string
  updatedAt: string
}

/** 与客户公开进度契约保持一致 */
export interface CustomerRefundProgress {
  runId: string
  returnNo: string
  orderNo: string
  type: 'return' | 'refund_only'
  progress:
    | 'awaiting_approval'
    | 'awaiting_shipment'
    | 'awaiting_receipt'
    | 'processing'
    | 'succeeded'
    | 'rejected'
    | 'expired'
    | 'cancelled'
    | 'failed'
    | 'unknown'
    | 'human'
  canRegisterShipment: boolean
  shipmentRegistered: boolean
  trackingNo: string | null
}

/** 会话满意度评分 */
export interface RunRatingView {
  runId: string
  score: number
  comment: string | null
  submittedAt: string
}

/** 运营分析总览 口径 source=customer */
export interface AnalyticsOverview {
  totalSessions: number
  statusCounts: Array<{ status: string; count: number }>
  resolutionRate: number
  escalationRate: number
  sessionsByDay: Array<{ day: string; count: number }>
  avgTurns: number
  toolDistribution: Array<{ toolName: string; total: number; failed: number }>
  avgApprovalLatencyMs: number | null
  decidedApprovalCount: number
  ratingCounts: Array<{ score: number; count: number }>
  ratingCount: number
  avgRating: number | null
  ratingByFinalStatus: Array<{ status: string; avgScore: number; count: number }>
  days: number
  scopeNote: string
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

/** 对齐审批执行公开契约 调用完成与业务成功分别展示 */
export interface ApprovalExecutionView {
  approvalId: string
  runId: string
  decision: 'approved' | 'rejected'
  decidedBy: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  lastError: string | null
  createdAt: string
  updatedAt: string
  resourceType: string | null
  resourceId: string | null
  amountCents: number | null
  businessStatus: string | null
  refundStatus: string | null
  taskStatus:
    | 'queued'
    | 'running'
    | 'completed'
    | 'call_failed'
    | 'business_failed'
    | 'needs_confirmation'
    | 'cancelled'
    | null
  outcome: 'pending' | 'running' | 'waiting_return' | 'succeeded' | 'failed' | 'closed' | 'unknown'
}

/** 结构化失败明细 kind 与判定四层映射 */
export type FailureKind =
  | 'state'
  | 'trajectory'
  | 'args'
  | 'escalation'
  | 'clarify'
  | 'gateway'
  | 'communicate'
  | 'judge'
  | 'simulator'
  | 'exception'

export interface EvalFailureView {
  kind: FailureKind
  message: string
}

export interface EvalCaseResultView {
  /** 旧报告未保存重复轮次 */
  repeat?: number
  caseId: string
  priority: string
  passed: boolean
  failures: EvalFailureView[]
  turns?: number
  agentInputTokens?: number
  agentOutputTokens?: number
  simulatorInputTokens?: number
  simulatorOutputTokens?: number
  agentCostUsd?: number
  simulatorCostUsd?: number
  judge?: Array<{ rubric: string; reason: string }>
  /** L2 运行标识 跳转运行详情时间线回放 */
  runId?: string
}

export interface EvalReportSummary {
  reportId: string
  startedAt: string
  model: string
  promptVersion: string
  level?: 'L1' | 'L2'
  userModel?: string
  judgeModel?: string
  total: number
  passed: number
  failed: number
  gatePassed: boolean
  report: {
    metrics?: Record<string, number>
    byCategory?: Record<string, { total: number; passed: number }>
    passPowerK?: number
    passAtK?: Record<string, number>
    confidenceIntervals?: Record<string, { lower: number; upper: number }>
    caseResults?: EvalCaseResultView[]
  }
}

/** L2 后台任务状态 来自 /api/eval/sim-tasks/:id */
export interface SimTaskView {
  status: 'running' | 'done' | 'error'
  progress: {
    round: number
    repeat: number
    caseIndex: number
    totalCases: number
    caseId: string
    passed: number
    failed: number
    elapsedMs: number
    failures: EvalFailureView[]
  } | null
  reportId: string | null
  error: string | null
  startedAt: string
}
