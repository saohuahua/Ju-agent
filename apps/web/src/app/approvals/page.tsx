'use client'

/**
 * 审批中心
 *
 * 主管视角的待办审批列表 决定按钮有重复提交保护
 */

import { useCallback, useEffect, useState } from 'react'
import { AppShell } from '@/components/AppShell'
import { api, ApiError } from '@/lib/api'
import { formatAmount } from '@/lib/runReducer'
import type { ApprovalRequest } from '@/lib/types'

const STATUS_LABEL: Record<ApprovalRequest['status'], string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  expired: '已过期',
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const body = await api.listApprovals()
      setApprovals(body.approvals)
      setError(null)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '加载失败')
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 3000)
    return () => clearInterval(timer)
  }, [load])

  const decide = async (approval: ApprovalRequest, decision: 'approved' | 'rejected') => {
    if (busyId) return
    if (!approval.runId) return
    setBusyId(approval.approvalId)
    try {
      await api.decideApproval(approval.runId, approval.approvalId, decision)
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '提交失败')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl px-6 py-8">
        <h1 className="text-lg font-semibold">审批中心</h1>
        <p className="mt-1 text-xs text-slate-400">
          大额或例外退款需要人工把关 决定通过一次性令牌传递给退款执行 重复点击不会产生两次副作用
        </p>
        {error && (
          <p className="mt-4 rounded-md bg-red-950/50 px-3 py-2 text-sm text-red-300">{error}</p>
        )}

        <div className="mt-6 space-y-3">
          {approvals.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-700 px-6 py-12 text-center text-sm text-slate-400">
              暂无待处理审批
            </div>
          )}
          {approvals.map((approval) => (
            <div
              key={approval.approvalId}
              className="rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-slate-100">
                      {formatAmount(approval.amountCents)}
                    </span>
                    <span className="rounded-full bg-orange-600/20 px-2 py-0.5 text-xs text-orange-300">
                      {STATUS_LABEL[approval.status]}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-slate-300">{approval.reason}</p>
                  <p className="mt-1 font-mono text-[11px] text-slate-500">
                    {approval.resourceType} {approval.resourceId} 会话 {approval.runId ?? '-'}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    截止 {new Date(approval.expiresAt).toLocaleString('zh-CN')}
                  </p>
                </div>
                {approval.status === 'pending' && (
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => decide(approval, 'approved')}
                      disabled={busyId === approval.approvalId}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      批准
                    </button>
                    <button
                      onClick={() => decide(approval, 'rejected')}
                      disabled={busyId === approval.approvalId}
                      className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
                    >
                      拒绝
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  )
}
