'use client'

/**
 * 运行记录列表
 */

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
        <h1 className="text-lg font-semibold">运行记录</h1>
        <p className="mt-1 text-xs text-slate-400">
          全部会话的状态与入口 点击进入查看事件时间线与断点
        </p>
        {error && (
          <p className="mt-4 rounded-md bg-red-950/50 px-3 py-2 text-sm text-red-300">{error}</p>
        )}

        <div className="mt-6 overflow-hidden rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/80 text-left text-xs text-slate-400">
              <tr>
                <th className="px-4 py-2.5 font-medium">运行</th>
                <th className="px-4 py-2.5 font-medium">客户</th>
                <th className="px-4 py-2.5 font-medium">意图</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium">开始时间</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {runs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                    暂无运行记录
                  </td>
                </tr>
              )}
              {runs.map((run) => (
                <tr key={run.runId} className="bg-slate-900/30 hover:bg-slate-900/60">
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-300">{run.runId}</td>
                  <td className="px-4 py-2.5">{run.customerId}</td>
                  <td className="px-4 py-2.5 text-slate-300">{run.intent ?? '-'}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-400">
                    {new Date(run.createdAt).toLocaleString('zh-CN')}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Link
                      href={`/runs/${run.runId}`}
                      className="text-xs text-sky-400 hover:text-sky-300"
                    >
                      详情 →
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
