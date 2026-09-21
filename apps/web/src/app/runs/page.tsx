'use client'

/**
 * 运行记录列表
 */

import { ArrowRight } from '@phosphor-icons/react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { AppShell } from '@/components/AppShell'
import { StatusBadge } from '@/components/StatusBadge'
import { api } from '@/lib/api'
import type { RunSummary } from '@/lib/types'

export default function RunsPage() {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .listRuns()
      .then((body) => setRuns(body.runs))
      .catch((caught) => setError(caught instanceof Error ? caught.message : '加载失败'))
  }, [])

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl px-6 py-8">
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

        <div className="mt-6 overflow-x-auto rounded-container border border-hairline bg-white">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-stone-500">
              <tr className="border-b border-hairline bg-stone-50">
                <th className="px-4 py-2.5 font-medium">运行</th>
                <th className="px-4 py-2.5 font-medium">客户</th>
                <th className="px-4 py-2.5 font-medium">意图</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium">开始时间</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {runs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-stone-500">
                    暂无运行记录
                  </td>
                </tr>
              )}
              {runs.map((run) => (
                <tr key={run.runId} className="transition-colors duration-200 hover:bg-stone-50">
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
      </div>
    </AppShell>
  )
}
