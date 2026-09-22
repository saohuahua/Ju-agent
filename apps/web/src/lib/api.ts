/**
 * API 客户端
 *
 * 统一注入身份令牌与错误处理 组件不直接拼 fetch
 */

import type {
  AgentEvent,
  AnalyticsOverview,
  ApprovalRequest,
  EvalReportSummary,
  RunRatingView,
  RunSummary,
  SimTaskView,
} from './types'

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8787'

const TOKEN_STORAGE_KEY = 'aftersales-token'

/** 演示令牌切换 本地存储 讲解环境专用 */
export const DEMO_TOKENS = [
  { label: '客户 张伟', value: 'cust-token-1001' },
  { label: '客户 李娜', value: 'cust-token-1002' },
  { label: '售后专员', value: 'operator-token' },
  { label: '主管 审批', value: 'supervisor-token' },
]

export function currentToken(): string {
  if (typeof window === 'undefined') return DEMO_TOKENS[0]!.value
  return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? DEMO_TOKENS[0]!.value
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
}

/** 当前演示身份角色 坐席工作台等内部页面的客户端门槛 */
export function currentRole(): 'customer' | 'operator' | 'supervisor' {
  const token = currentToken()
  if (token === 'operator-token') return 'operator'
  if (token === 'supervisor-token') return 'supervisor'
  return 'customer'
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${currentToken()}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string }
    throw new ApiError(
      response.status,
      body.error ?? 'UNKNOWN',
      body.message ?? `请求失败 ${response.status}`,
    )
  }
  return (await response.json()) as T
}

export interface HealthInfo {
  status: string
  modelAvailable: boolean
  promptVersion: string
}

export const api = {
  health: () => request<HealthInfo>('/api/health'),

  createRun: (message: string, customerId?: string) =>
    request<{ runId: string }>('/api/runs', {
      method: 'POST',
      body: JSON.stringify(customerId ? { message, customerId } : { message }),
    }),

  continueRun: (runId: string, message: string) =>
    request<{ runId: string }>(`/api/runs/${runId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  getRun: (runId: string) => request<{ run: RunSummary }>(`/api/runs/${runId}`),

  listRuns: (status?: string) =>
    request<{ runs: RunSummary[] }>(`/api/runs${status ? `?status=${status}` : ''}`),

  listEvents: (runId: string, from = 1) =>
    request<{ events: AgentEvent[] }>(`/api/runs/${runId}/events/json?from=${from}`),

  listApprovals: () => request<{ approvals: ApprovalRequest[] }>('/api/approvals'),

  decideApproval: (runId: string, approvalId: string, decision: 'approved' | 'rejected') =>
    request<{ runId: string; approvalId: string; decision: 'approved' | 'rejected' }>(
      `/api/runs/${runId}/approvals/${approvalId}/decide`,
      {
        method: 'POST',
        body: JSON.stringify({ decision, decidedBy: 'supervisor' }),
      },
    ),

  resumeRun: (runId: string) =>
    request<{ runId: string }>(`/api/runs/${runId}/resume`, { method: 'POST' }),

  takeOverRun: (runId: string) =>
    request<{ runId: string; status: string }>(`/api/runs/${runId}/handover`, {
      method: 'POST',
    }),

  sendOperatorMessage: (runId: string, message: string) =>
    request<{ runId: string }>(`/api/runs/${runId}/operator-messages`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  resolveRun: (runId: string, summary: string) =>
    request<{ runId: string; status: string }>(`/api/runs/${runId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ summary }),
    }),

  injectLogisticsEvent: (
    runId: string,
    body: { orderNo: string; status: 'delayed' | 'lost'; description: string; eventId?: string },
  ) =>
    request<{
      runId: string
      event: {
        orderNo: string
        status: string
        description: string
        eventId: string
        injectedAt: string
      }
      delivered: boolean
      outcome: string | null
    }>(`/api/runs/${runId}/logistics-events`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  receiveGoods: (returnNo: string) =>
    request<{ result: Record<string, unknown> }>('/api/operations/receive-goods', {
      method: 'POST',
      body: JSON.stringify({ returnNo }),
    }),

  listEvalReports: () => request<{ reports: EvalReportSummary[] }>('/api/eval/reports'),

  runEval: () =>
    request<{ reportId: string; total: number; passed: number; gatePassed: boolean }>(
      '/api/eval/run',
      {
        method: 'POST',
      },
    ),

  startSimEval: (body: {
    sample: string
    repeat: number
    /** 空串省略 由后端回退到环境默认模型 */
    agentModel?: string
    userModel?: string
    judgeModel?: string
  }) =>
    request<{ taskId: string; totalCases: number; estimatedTokens: number; startedAt: string }>(
      '/api/eval/run-sim',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),

  getSimTask: (taskId: string) => request<{ task: SimTaskView }>(`/api/eval/sim-tasks/${taskId}`),

  submitRating: (runId: string, score: number, comment?: string) =>
    request<{ rating: RunRatingView }>(`/api/runs/${runId}/rating`, {
      method: 'POST',
      body: JSON.stringify(comment ? { score, comment } : { score }),
    }),

  getRating: (runId: string) =>
    request<{ rating: RunRatingView | null }>(`/api/runs/${runId}/rating`),

  getAnalytics: (days = 14) => request<AnalyticsOverview>(`/api/analytics/overview?days=${days}`),
}
