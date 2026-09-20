'use client'

/**
 * 审批卡片
 *
 * 工作台内嵌的审批视图 展示风险信息与金额
 * 决定操作只在确认后提交一次 按钮在请求期间锁定
 */

import { useState } from 'react'
import { api } from '@/lib/api'
import { formatAmount, type ApprovalItem } from '@/lib/runReducer'

export function ApprovalCard({
  approval,
  runId,
  canDecide,
  onDecided,
}: {
  approval: ApprovalItem
  runId: string
  canDecide: boolean
  onDecided: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const decide = async (decision: 'approved' | 'rejected') => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await api.decideApproval(runId, approval.approvalId, decision)
      onDecided()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-lg border border-orange-700/60 bg-orange-950/30 px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-orange-200">需要人工审批</span>
        <span className="text-sm font-semibold text-orange-100">
          {formatAmount(approval.amountCents)}
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-300">{approval.reason}</p>
      <p className="mt-0.5 font-mono text-[11px] text-slate-500">资源 {approval.resourceId}</p>

      {approval.status === 'pending' ? (
        canDecide && !submitting ? (
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => decide('approved')}
              disabled={submitting}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              批准退款
            </button>
            <button
              onClick={() => decide('rejected')}
              disabled={submitting}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
            >
              拒绝
            </button>
          </div>
        ) : (
          <p className="mt-2 text-xs text-slate-400">等待主管在审批中心处理</p>
        )
      ) : (
        <p className="mt-2 text-xs text-slate-400">
          审批结果{' '}
          {approval.status === 'approved'
            ? '已批准'
            : approval.status === 'rejected'
              ? '已拒绝'
              : '已过期'}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  )
}
