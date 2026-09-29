'use client'

import { NavigationLink as Link } from '@/components/NavigationLink'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, Clock3, ShieldCheck } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RefreshButton } from '@/components/ui/refresh-button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useIdentity } from '@/lib/identity'
import { formatAmount } from '@/lib/runReducer'
import type { ApprovalRequest } from '@/lib/types'
import {
  approvalError,
  approvalState,
  formatApprovalTime,
  resourceName,
} from '@/components/approvals/presentation'
import styles from '@/components/approvals/Approvals.module.css'
import { ExecutionProgress } from '@/components/approvals/ExecutionProgress'

type Decision = 'approved' | 'rejected'
type Notice = { kind: 'success' | 'error'; title: string; message: string; runId?: string } | null

export default function ApprovalsPage() {
  const { token, role } = useIdentity()

  return (
    <>
      {role === 'customer' ? (
        <div className="youju-page">
          <Empty className="mt-8 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShieldCheck aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>审批中心仅供售后团队使用</EmptyTitle>
              <EmptyDescription>请从客户服务入口查看处理进度</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <ApprovalWorkspace key={token} canDecide={role === 'supervisor'} />
      )}
    </>
  )
}

function ApprovalWorkspace({ canDecide }: { canDecide: boolean }) {
  const client = useQueryClient()
  const [now, setNow] = useState(() => Date.now())
  const [selection, setSelection] = useState<{
    approval: ApprovalRequest
    decision: Decision
  } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const submitting = useRef(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  const list = useQuery({
    queryKey: ['approvals', 'pending'],
    queryFn: ({ signal }) => api.listApprovals(signal),
    refetchInterval: busyId ? false : 5000,
  })

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const decide = async () => {
    if (!selection || !canDecide || submitting.current) return

    const { approval, decision } = selection
    if (!approval.runId || approvalState(approval, Date.now()) !== 'pending') {
      setNotice({
        kind: 'error',
        title: '无法提交决定',
        message: '审批已过期或缺少关联会话 请刷新待办',
      })
      setSelection(null)
      void list.refetch()
      return
    }
    if (!list.data?.approvals.some((item) => item.approvalId === approval.approvalId)) {
      setNotice({
        kind: 'error',
        title: '待办已变化',
        message: '该审批已不在待办列表 请核对最新状态',
      })
      setSelection(null)
      return
    }

    // 同一决定只允许一个在途请求
    submitting.current = true
    setBusyId(approval.approvalId)
    setNotice(null)
    try {
      await api.decideApproval(approval.runId, approval.approvalId, decision)
      setSelection(null)
      setNotice({
        kind: 'success',
        title: decision === 'approved' ? '同意决定已受理' : '拒绝决定已受理',
        message: '请在下方执行进度查看处理状态 业务结果以实际记录为准',
        runId: approval.runId,
      })
      void list.refetch()
      void client.invalidateQueries({ queryKey: ['approvals', 'executions'] })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return

      const detail = approvalError(error)
      setSelection(null)
      setNotice({ kind: 'error', title: detail.title, message: detail.message })
      if (detail.refresh) void list.refetch()
    } finally {
      submitting.current = false
      setBusyId(null)
    }
  }

  const selectedState = selection ? approvalState(selection.approval, now) : null

  return (
    <div className="youju-page">
      <header className="youju-page-heading">
        <div>
          <p className="youju-eyebrow">风险方案由主管核验</p>
          <h1>审批中心</h1>
          <p>核对业务对象 金额和申请理由后作出决定</p>
        </div>
        <RefreshButton
          variant="outline"
          onRefresh={() => list.refetch()}
          disabled={list.isFetching || !!busyId}
        >
          刷新待办
        </RefreshButton>
      </header>

      <div className={styles.summary}>
        <span>
          待审批 <strong>{list.data?.approvals.length ?? '—'}</strong> 项
        </span>
        <span>{canDecide ? '主管决定权限' : '坐席只读视图'}</span>
        <span>审批决定与业务执行分别记录</span>
      </div>

      {notice && (
        <Alert
          variant={notice.kind === 'error' ? 'destructive' : 'default'}
          className="mb-5"
          aria-live="polite"
        >
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>
            {notice.message}
            {notice.runId && (
              <Button asChild variant="link" size="sm">
                <Link href={`/runs/${encodeURIComponent(notice.runId)}`}>
                  查看关联会话 <ArrowUpRight data-icon="inline-end" aria-hidden="true" />
                </Link>
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {list.isError && (
        <Alert variant="destructive" className="mb-5">
          <AlertTitle>待办加载失败</AlertTitle>
          <AlertDescription>
            {list.error instanceof Error ? list.error.message : '请稍后重试'}
            <RefreshButton
              variant="link"
              disabled={list.isFetching}
              onRefresh={() => list.refetch()}
            >
              重试
            </RefreshButton>
          </AlertDescription>
        </Alert>
      )}

      <div className={styles.layout}>
        <section aria-label="待审批列表" className={styles.list}>
          {list.isPending ? (
            <div className={styles.loading} role="status" aria-label="正在读取审批待办">
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} className="h-40 w-full" />
              ))}
            </div>
          ) : list.isError ? null : list.data.approvals.length === 0 ? (
            <Empty className={styles.empty}>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ShieldCheck aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>当前没有待审批事项</EmptyTitle>
                <EmptyDescription>新申请出现后会自动更新 也可手动刷新</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            list.data.approvals.map((approval) => {
              const state = approvalState(approval, now)
              const isBusy = busyId === approval.approvalId

              return (
                <article key={approval.approvalId} className={styles.row}>
                  <div className={styles.details}>
                    <div className={styles.rowTop}>
                      <span className={styles.identifier}>
                        {resourceName(approval.resourceType)} · {approval.resourceId}
                      </span>
                      <Badge variant={state === 'pending' ? 'secondary' : 'outline'}>
                        {state === 'pending' ? '待审批' : state === 'expired' ? '已过期' : '已处理'}
                      </Badge>
                    </div>
                    <h2>{approval.reason}</h2>
                    <p className={styles.meta}>申请编号 {approval.approvalId}</p>
                    <p className={styles.deadline}>
                      <Clock3 aria-hidden="true" />
                      有效期至 {formatApprovalTime(approval.expiresAt)}
                    </p>

                    <div className={styles.actions}>
                      {canDecide && state === 'pending' && approval.runId && (
                        <>
                          <Button
                            size="sm"
                            disabled={!!busyId || list.isError}
                            onClick={() => setSelection({ approval, decision: 'approved' })}
                          >
                            同意方案
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!!busyId || list.isError}
                            onClick={() => setSelection({ approval, decision: 'rejected' })}
                          >
                            拒绝方案
                          </Button>
                        </>
                      )}
                      {isBusy && (
                        <span className={styles.pending} role="status">
                          正在提交决定
                        </span>
                      )}
                      {!canDecide && state === 'pending' && (
                        <span className={styles.pending}>仅主管可作决定</span>
                      )}
                      {state === 'expired' && (
                        <span className={styles.pending}>有效期已结束 请重新核验</span>
                      )}
                      {!approval.runId && (
                        <span className={styles.pending}>缺少关联会话 无法在此决定</span>
                      )}
                      {approval.runId && (
                        <Button asChild variant="link" size="sm">
                          <Link href={`/runs/${encodeURIComponent(approval.runId)}`}>
                            查看关联会话 <ArrowUpRight data-icon="inline-end" aria-hidden="true" />
                          </Link>
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className={styles.amount}>
                    <span>申请金额</span>
                    <strong>{formatAmount(approval.amountCents)}</strong>
                  </div>
                </article>
              )
            })
          )}
        </section>

        <aside className={styles.note} aria-label="审批边界">
          <ShieldCheck aria-hidden="true" />
          <h2>决定之后 仍需核验</h2>
          <p>同意方案只表示审批决定已受理 后续处理结果以关联会话和业务记录为准</p>
          <p>下方同时显示调用进度和业务结果 结果未知时请先核验 不要重复发起资金操作</p>
        </aside>
      </div>

      <ExecutionProgress />

      <Dialog
        open={!!selection}
        onOpenChange={(open) => {
          if (!open && !busyId) setSelection(null)
        }}
      >
        <DialogContent
          onOpenAutoFocus={() => {
            const active = document.activeElement
            returnFocus.current = active instanceof HTMLElement ? active : null
          }}
          onCloseAutoFocus={(event) => {
            // 取消后回到原按钮 提交后按钮消失时交还页面的自然焦点
            if (returnFocus.current?.isConnected) {
              event.preventDefault()
              returnFocus.current.focus()
            }
          }}
          showCloseButton={!busyId}
          onEscapeKeyDown={(event) => {
            if (busyId) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            if (busyId) event.preventDefault()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {selection?.decision === 'approved' ? '确认同意方案' : '确认拒绝方案'}
            </DialogTitle>
            <DialogDescription>请再次核对业务对象与金额 决定提交后不可在此撤回</DialogDescription>
          </DialogHeader>
          {selection && (
            <div className={styles.confirmDetails}>
              <p>
                {resourceName(selection.approval.resourceType)} · {selection.approval.resourceId}
              </p>
              <strong>{formatAmount(selection.approval.amountCents)}</strong>
              <p>{selection.approval.reason}</p>
              <p>有效期至 {formatApprovalTime(selection.approval.expiresAt)}</p>
              {selectedState !== 'pending' && (
                <p className={styles.expired}>审批已过期 请刷新待办</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={!!busyId} onClick={() => setSelection(null)}>
              取消
            </Button>
            <Button
              variant={selection?.decision === 'rejected' ? 'destructive' : 'default'}
              disabled={!!busyId || selectedState !== 'pending'}
              loading={!!busyId}
              onClick={() => void decide()}
            >
              {selection?.decision === 'approved' ? '确认同意' : '确认拒绝'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
