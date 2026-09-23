'use client'

/**
 * 审批中心
 *
 * 主管视角的待办审批列表 决定按钮有重复提交保护
 */

import { Tray } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { AppShell } from '@/components/AppShell'
import { Skeleton } from '@/components/Skeleton'
import { api, ApiError } from '@/lib/api'
import { formatAmount } from '@/lib/runReducer'
import type { ApprovalRequest } from '@/lib/types'

const STATUS_LABEL: Record<ApprovalRequest['status'], string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  expired: '已过期',
}

const STATUS_STYLE: Record<ApprovalRequest['status'], string> = {
  pending: 'border-orange-200 bg-orange-50 text-orange-800',
  approved: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  rejected: 'border-red-200 bg-red-50 text-red-800',
  expired: 'border-stone-200 bg-stone-100 text-stone-500',
}

/** 审批资源类型中文名 新业务资源类型在此登记 */
const RESOURCE_LABEL: Record<string, string> = {
  return_request: '售后单',
  compensation: '补偿单',
  price_protection: '价保单',
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const body = await api.listApprovals()
      setApprovals(body.approvals)
      setError(null)
      setLastRefresh(new Date())
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '加载失败')
    } finally {
      setLoading(false)
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
      <div className="page-enter mx-auto max-w-4xl px-6 py-8">
        <div className="flex items-center justify-between gap-6">
          <h1 className="shrink-0 text-xl font-semibold tracking-tight">审批中心</h1>
          <div className="flex min-w-0 items-center gap-4">
            <p className="min-w-0 text-right text-sm text-stone-500">
              大额退款与超额补偿需要人工把关 决定通过一次性令牌传递给执行环节 重复点击不会产生两次副作用
            </p>
            {lastRefresh && (
              <p className="shrink-0 font-mono text-xs tabular-nums text-stone-400">
                最后刷新{' '}
                {lastRefresh.toLocaleTimeString('zh-CN', {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </p>
            )}
          </div>
        </div>
        {error && (
          <p className="mt-4 rounded-control border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        {loading && (
          <div className="mt-6 space-y-3">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="rounded-container border border-hairline bg-surface px-5 py-4"
              >
                <div className="flex items-center gap-3">
                  <Skeleton className="h-6 w-28" />
                  <Skeleton className="h-4 w-16" />
                </div>
                <Skeleton className="mt-2 h-4 w-2/3" />
                <Skeleton className="mt-2 h-3 w-1/2" />
              </div>
            ))}
          </div>
        )}

        {!loading && (
          <div className="mt-6 space-y-3">
            {approvals.length === 0 && (
              <div className="flex flex-col items-center gap-2 rounded-container border border-dashed border-stone-300 px-6 py-12 text-sm text-stone-500">
                <Tray size={28} className="text-stone-300" aria-hidden="true" />
                <span>暂无待处理审批</span>
              </div>
            )}
          {approvals.map((approval) => (
            <div
              key={approval.approvalId}
              className="rounded-container border border-hairline bg-surface px-5 py-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-semibold font-mono text-stone-900">
                      {formatAmount(approval.amountCents)}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-badge border px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[approval.status]}`}
                    >
                      {STATUS_LABEL[approval.status]}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-stone-600">{approval.reason}</p>
                  <p className="mt-1 font-mono text-[11px] text-stone-500">
                    {RESOURCE_LABEL[approval.resourceType] ?? approval.resourceType} {approval.resourceId} 会话 {approval.runId ?? '-'}
                  </p>
                  <p className="mt-0.5 text-[11px] tabular-nums text-stone-500">
                    截止 {new Date(approval.expiresAt).toLocaleString('zh-CN')}
                  </p>
                </div>
                {approval.status === 'pending' && (
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => decide(approval, 'approved')}
                      disabled={busyId === approval.approvalId}
                      className="rounded-control bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white transition-colors duration-200 hover:bg-emerald-800 active:scale-[0.98] disabled:opacity-50"
                    >
                      批准
                    </button>
                    <button
                      onClick={() => decide(approval, 'rejected')}
                      disabled={busyId === approval.approvalId}
                      className="rounded-control bg-red-700 px-3 py-1.5 text-xs font-medium text-white transition-colors duration-200 hover:bg-red-800 active:scale-[0.98] disabled:opacity-50"
                    >
                      拒绝
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
          </div>
        )}
      </div>
    </AppShell>
  )
}
