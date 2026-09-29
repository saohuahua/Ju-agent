'use client'

/**
 * 运行记录列表
 */

import { ArrowRight, ClockCounterClockwise } from '@phosphor-icons/react'
import { NavigationLink as Link } from '@/components/NavigationLink'
import { useQuery } from '@tanstack/react-query'
import { Skeleton } from '@/components/Skeleton'
import { StatusBadge } from '@/components/StatusBadge'
import { api } from '@/lib/api'

export default function RunsPage() {
  // 列表返回时复用缓存 身份切换仍由上层提供器隔离数据
  const query = useQuery({ queryKey: ['runs'], queryFn: () => api.listRuns() })
  const runs = query.data?.runs ?? []
  const error = query.error?.message
  const loading = query.isPending

  return (
    <>
      <div className="page-enter mx-auto max-w-5xl px-6 py-8">
        <div className="flex items-center justify-between gap-6">
          <h1 className="shrink-0 text-xl font-semibold tracking-tight">运行记录</h1>
          <p className="min-w-0 text-right text-sm text-stone-500">
            全部会话的状态与入口 点击进入查看事件时间线与断点
          </p>
        </div>
        {error && (
          <p className="mt-4 rounded-control border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        {loading && (
          <div className="mt-6 overflow-x-auto" role="status" aria-label="正在读取运行记录">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-hairline">
                {[0, 1, 2, 3].map((index) => (
                  <tr key={index}>
                    <td className="px-4 py-2.5">
                      <Skeleton className="h-4 w-32" />
                    </td>
                    <td className="px-4 py-2.5">
                      <Skeleton className="h-4 w-16" />
                    </td>
                    <td className="px-4 py-2.5">
                      <Skeleton className="h-4 w-20" />
                    </td>
                    <td className="px-4 py-2.5">
                      <Skeleton className="h-5 w-20" />
                    </td>
                    <td className="px-4 py-2.5">
                      <Skeleton className="h-4 w-28" />
                    </td>
                    <td className="px-4 py-2.5" />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && runs.length === 0 && (
          <div className="mt-6 flex flex-col items-center gap-2 rounded-container border border-dashed border-stone-300 px-6 py-12 text-sm text-stone-500">
            <ClockCounterClockwise size={28} className="text-stone-300" aria-hidden="true" />
            <span>暂无运行记录</span>
          </div>
        )}

        {!loading && runs.length > 0 && (
          <div className="mt-6 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-stone-500">
                <tr className="border-b border-hairline">
                  <th className="px-4 py-2.5 font-medium">运行</th>
                  <th className="px-4 py-2.5 font-medium">客户</th>
                  <th className="px-4 py-2.5 font-medium">意图</th>
                  <th className="px-4 py-2.5 font-medium">状态</th>
                  <th className="px-4 py-2.5 font-medium">开始时间</th>
                  <th className="px-4 py-2.5 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {runs.map((run) => (
                  <tr key={run.runId} className="transition-colors duration-200 hover:bg-stone-100">
                    <td className="px-4 py-2.5 font-mono text-xs text-stone-600">{run.runId}</td>
                    <td className="px-4 py-2.5 text-stone-700">{run.customerId}</td>
                    <td className="px-4 py-2.5 text-stone-600">{run.intent ?? '-'}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="px-4 py-2.5 text-xs tabular-nums text-stone-500">
                      {new Date(run.createdAt).toLocaleString('zh-CN')}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Link
                        href={`/runs/${run.runId}`}
                        className="inline-flex items-center gap-1 text-xs font-medium text-sage-700 transition-colors duration-200 hover:text-sage-800"
                      >
                        详情
                        <ArrowRight size={12} weight="bold" aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
