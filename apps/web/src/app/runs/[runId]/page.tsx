'use client'

/**
 * 运行详情页
 *
 * 通过事件 JSON 端点全量重建时间线
 * 运行卡在执行态时提供断点恢复入口
 */

import { use, useCallback, useEffect, useState } from 'react'
import { AppShell } from '@/components/AppShell'
import { Skeleton } from '@/components/Skeleton'
import { StatusBadge } from '@/components/StatusBadge'
import { ToolCard } from '@/components/ToolCard'
import { api } from '@/lib/api'
import { reduceEvents, initialViewState } from '@/lib/runReducer'
import type { AgentEvent, RunSummary } from '@/lib/types'

const EVENT_TYPE_LABEL: Record<string, string> = {
  'run.started': '运行开始',
  'message.user': '用户消息',
  'message.delta': '回复片段',
  'message.completed': '回复完成',
  'agent.output': '模型输出',
  'step.started': '步骤开始',
  'step.completed': '步骤完成',
  'tool.requested': '工具调用',
  'tool.completed': '工具结果',
  'approval.required': '需要审批',
  'approval.decided': '审批决定',
  'run.paused': '运行暂停',
  'run.resumed': '运行恢复',
  'run.failed': '运行失败',
  'run.completed': '运行完成',
  'run.escalated': '升级人工',
}

export default function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params)
  const [run, setRun] = useState<RunSummary | null>(null)
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)

  const load = useCallback(async () => {
    try {
      const [runBody, eventBody] = await Promise.all([api.getRun(runId), api.listEvents(runId)])
      setRun(runBody.run)
      setEvents(eventBody.events)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '加载失败')
    }
  }, [runId])

  useEffect(() => {
    load()
  }, [load])

  const view = reduceEvents(initialViewState(), events)
  const stuck = run?.status === 'running'
  const loading = run === null && !error

  const resume = async () => {
    if (resuming) return
    setResuming(true)
    try {
      await api.resumeRun(runId)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '恢复失败')
    } finally {
      setResuming(false)
    }
  }

  return (
    <AppShell>
      <div className="page-enter mx-auto max-w-4xl px-6 py-8">
        <div className="flex items-center justify-between gap-4">
          <h1 className="flex shrink-0 items-center gap-3 text-xl font-semibold tracking-tight">
            运行详情
            {run && <StatusBadge status={run.status} />}
          </h1>
          <div className="flex min-w-0 items-center gap-4">
            <p className="truncate font-mono text-xs text-stone-500">{runId}</p>
            {stuck && (
              <button
                onClick={resume}
                disabled={resuming}
                className="shrink-0 rounded-control bg-amber-700 px-4 py-2 text-xs font-medium text-white transition-colors duration-200 hover:bg-amber-800 active:scale-[0.98] disabled:opacity-50"
              >
                {resuming ? '恢复中' : '断点恢复'}
              </button>
            )}
          </div>
        </div>

        {loading && (
          <>
            <div className="mt-6 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
              {[0, 1, 2, 3].map((index) => (
                <div key={index}>
                  <Skeleton className="h-3 w-14" />
                  <Skeleton className="mt-1.5 h-4 w-24" />
                </div>
              ))}
            </div>
            <div className="mt-6 space-y-2">
              {[0, 1, 2, 3, 4].map((index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
          </>
        )}

        {!loading && run && (
          <div className="mt-6 grid grid-cols-2 gap-x-8 gap-y-4 text-sm sm:grid-cols-4">
            <div>
              <div className="text-xs text-stone-500">客户</div>
              <div className="mt-0.5 text-stone-900">{run.customerId}</div>
            </div>
            <div>
              <div className="text-xs text-stone-500">意图</div>
              <div className="mt-0.5 text-stone-900">{run.intent ?? '-'}</div>
            </div>
            <div>
              <div className="text-xs text-stone-500">模型</div>
              <div className="mt-0.5 font-mono text-xs text-stone-700">{run.model}</div>
            </div>
            <div>
              <div className="text-xs text-stone-500">提示词版本</div>
              <div className="mt-0.5 font-mono text-xs text-stone-700">{run.promptVersion}</div>
            </div>
          </div>
        )}

        {error && (
          <p className="mt-4 rounded-control border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        {view.tools.length > 0 && (
          <section className="mt-6">
            <h2 className="mb-2 text-sm font-medium text-stone-700">工具轨迹</h2>
            <div className="space-y-1.5">
              {view.tools.map((tool) => (
                <ToolCard key={tool.executionId} tool={tool} />
              ))}
            </div>
          </section>
        )}

        <section className="mt-6">
          <h2 className="mb-2 text-sm font-medium text-stone-700">事件时间线</h2>
          <div className="overflow-x-auto rounded-container border border-hairline bg-white">
            <table className="w-full text-xs">
              <thead className="text-left text-stone-500">
                <tr className="border-b border-hairline">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">事件</th>
                  <th className="px-3 py-2 font-medium">内容摘要</th>
                  <th className="px-3 py-2 font-medium">时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {events.map((event) => (
                  <tr key={event.sequence} className="transition-colors duration-200 hover:bg-stone-50">
                    <td className="px-3 py-1.5 font-mono tabular-nums text-stone-500">
                      {event.sequence}
                    </td>
                    <td className="px-3 py-1.5 text-stone-700">
                      {EVENT_TYPE_LABEL[event.type] ?? event.type}
                    </td>
                    <td className="max-w-md truncate px-3 py-1.5 font-mono text-[11px] text-stone-500">
                      {summarizePayload(event)}
                    </td>
                    <td className="px-3 py-1.5 tabular-nums text-stone-500">
                      {new Date(event.createdAt).toLocaleTimeString('zh-CN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </AppShell>
  )
}

function summarizePayload(event: AgentEvent): string {
  const payload = event.payload as Record<string, unknown>
  const keys = Object.keys(payload)
  if (keys.length === 0) return ''
  const first = keys[0]!
  const value = payload[first]
  if (typeof value === 'string') return value.slice(0, 80)
  return JSON.stringify(payload).slice(0, 100)
}
