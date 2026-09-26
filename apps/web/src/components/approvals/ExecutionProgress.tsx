'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatAmount } from '@/lib/runReducer'
import {
  durableTaskState,
  executionOutcome,
  executionState,
  formatApprovalTime,
  resourceName,
} from './presentation'
import styles from './Approvals.module.css'

/** 独立查询避免待办失败遮挡执行记录 身份切换由上层重建缓存 */
export function ExecutionProgress() {
  const records = useQuery({
    queryKey: ['approvals', 'executions'],
    queryFn: ({ signal }) => api.listApprovalExecutions(signal),
    refetchInterval: 5000,
  })

  return (
    <section aria-label="审批执行进度" className={styles.executionSection}>
      <div className={styles.rowTop}>
        <h2>决定后的执行进度</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void records.refetch()}
          disabled={records.isFetching}
        >
          <RefreshCw data-icon="inline-start" aria-hidden="true" />
          刷新执行进度
        </Button>
      </div>
      <p className={styles.meta}>
        最近 {records.data?.limit ?? 100} 条执行记录 每 5 秒更新 调用结束后仍需核验业务结果
      </p>
      {records.isError ? (
        <Alert variant="destructive">
          <AlertTitle>执行进度加载失败</AlertTitle>
          <AlertDescription>无法确认最新结果 请重试 已有记录不会作为当前成功依据</AlertDescription>
        </Alert>
      ) : records.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : records.data.executions.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>暂无执行记录</EmptyTitle>
            <EmptyDescription>审批决定受理后会在这里显示后续进度</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className={styles.list}>
          {records.data.executions.map((record) => {
            const result = executionOutcome(record.outcome)
            return (
              <article
                key={record.approvalId}
                className={styles.row}
                aria-label={`执行记录 ${record.approvalId}`}
              >
                <div className={styles.details}>
                  <div className={styles.rowTop}>
                    <span className={styles.identifier}>
                      {resourceName(record.resourceType ?? '未知业务')} ·{' '}
                      {record.resourceId ?? '关联记录缺失'}
                    </span>
                    <Badge variant="outline">
                      {record.decision === 'approved' ? '已同意' : '已拒绝'}
                    </Badge>
                    <Badge variant={result.warning ? 'destructive' : 'secondary'}>
                      {result.label}
                    </Badge>
                  </div>
                  <h3>{result.description}</h3>
                  <p className={styles.meta}>
                    调用进度 {executionState(record.status)} · 决定人 {record.decidedBy}
                  </p>
                  {record.taskStatus && (
                    <p className={styles.meta}>持久任务 {durableTaskState(record.taskStatus)}</p>
                  )}
                  <p className={styles.meta}>
                    申请编号 {record.approvalId} · 更新于 {formatApprovalTime(record.updatedAt)}
                  </p>
                  {record.lastError && (
                    <p className={styles.pending} role="status">
                      {record.lastError}
                    </p>
                  )}
                  <div className={styles.actions}>
                    <Button asChild variant="link" size="sm">
                      <Link href={`/runs/${encodeURIComponent(record.runId)}`}>
                        查看关联会话
                        <ArrowUpRight data-icon="inline-end" aria-hidden="true" />
                      </Link>
                    </Button>
                  </div>
                </div>
                <div className={styles.amount}>
                  <span>审批金额</span>
                  <strong>
                    {record.amountCents === null ? '待核验' : formatAmount(record.amountCents)}
                  </strong>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
