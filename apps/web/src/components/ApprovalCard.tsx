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

  const isCompensation = approval.resourceType === 'compensation'
  const isPriceProtection = approval.resourceType === 'price_protection'
  const resourceLabel = isCompensation ? '补偿单' : isPriceProtection ? '价保单' : '售后单'

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
    <div className="rounded-container border border-orange-200 bg-orange-50/70 px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-orange-900">
          {isCompensation
            ? '大额补偿需要人工审批'
            : isPriceProtection
              ? '大额价保需要人工审批'
              : '需要人工审批'}
        </span>
        <span className="text-lg font-semibold font-mono text-stone-900">
          {formatAmount(approval.amountCents)}
        </span>
      </div>
      <p className="mt-1 text-xs text-stone-600">{approval.reason}</p>
      <p className="mt-0.5 font-mono text-[11px] text-stone-500">
        {resourceLabel} {approval.resourceId}
      </p>

      {approval.status === 'pending' ? (
        canDecide && !submitting ? (
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => decide('approved')}
              disabled={submitting}
              className="rounded-control bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white transition-colors duration-200 hover:bg-emerald-800 active:scale-[0.98] disabled:opacity-50"
            >
              {isCompensation ? '批准发放' : isPriceProtection ? '批准退还' : '批准退款'}
            </button>
            <button
              onClick={() => decide('rejected')}
              disabled={submitting}
              className="rounded-control bg-red-700 px-3 py-1.5 text-xs font-medium text-white transition-colors duration-200 hover:bg-red-800 active:scale-[0.98] disabled:opacity-50"
            >
              拒绝
            </button>
          </div>
        ) : (
          <p className="mt-2 text-xs text-stone-500">等待主管在审批中心处理</p>
        )
      ) : (
        <p className="mt-2 text-xs text-stone-500">
          审批结果{' '}
          {approval.status === 'approved'
            ? '已批准'
            : approval.status === 'rejected'
              ? '已拒绝'
              : '已过期'}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  )
}
