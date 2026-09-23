'use client'

/**
 * 运行详情页
 *
 * 通过事件 JSON 端点全量重建时间线
 * 运行卡在执行态时提供断点恢复入口
 * 操作员可在此注入物流事件 空闲会话即时触达 忙时会话挂起下一轮
 */

import { use, useCallback, useEffect, useState, type FormEvent } from 'react'
import { AppShell } from '@/components/AppShell'
import { Skeleton } from '@/components/Skeleton'
import { StatusBadge } from '@/components/StatusBadge'
import { ToolCard } from '@/components/ToolCard'
import { api, currentToken } from '@/lib/api'
import { reduceEvents, initialViewState } from '@/lib/runReducer'
import type { AgentEvent, RunRatingView, RunSummary } from '@/lib/types'

const EVENT_TYPE_LABEL: Record<string, string> = {
  'run.started': '运行开始',
  'message.user': '用户消息',
  'message.delta': '回复片段',
  'message.completed': '回复完成',
  'agent.output': '模型输出',
  'agent.turn': '模型轮次',
  'agent.tool_results': '工具结果回灌',
  'tool.input.delta': '工具参数流式',
  'context.compacted': '上下文压缩',
  'step.started': '步骤开始',
  'step.completed': '步骤完成',
  'tool.requested': '工具调用',
  'tool.completed': '工具结果',
  'approval.required': '需要审批',
  'approval.decided': '审批决定',
  'logistics.event': '物流事件',
  'run.paused': '运行暂停',
  'run.resumed': '运行恢复',
  'run.failed': '运行失败',
  'run.completed': '运行完成',
  'run.escalated': '升级人工',
  'run.handover': '坐席接管',
  'operator.message': '坐席消息',
  'run.resolved': '坐席标记解决',
}

export default function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params)
  const [run, setRun] = useState<RunSummary | null>(null)
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [rating, setRating] = useState<RunRatingView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)

  // 物流事件注入表单 仅操作员与主管可见
  const isOperator = ['operator-token', 'supervisor-token'].includes(currentToken())
  const [injectOrderNo, setInjectOrderNo] = useState('')
  const [injectStatus, setInjectStatus] = useState<'delayed' | 'lost'>('delayed')
  const [injectDescription, setInjectDescription] = useState('')
  const [injecting, setInjecting] = useState(false)
  const [injectResult, setInjectResult] = useState<string | null>(null)
  const [injectError, setInjectError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [runBody, eventBody, ratingBody] = await Promise.all([
        api.getRun(runId),
        api.listEvents(runId),
        api.getRating(runId).catch(() => ({ rating: null })),
      ])
      setRun(runBody.run)
      setEvents(eventBody.events)
      setRating(ratingBody.rating)
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

  const inject = async (event: FormEvent) => {
    event.preventDefault()
    if (injecting) return
    setInjecting(true)
    setInjectResult(null)
    setInjectError(null)
    try {
      const result = await api.injectLogisticsEvent(runId, {
        orderNo: injectOrderNo.trim(),
        status: injectStatus,
        description: injectDescription.trim(),
      })
      setInjectResult(
        result.delivered
          ? '已注入并即时触达 会话正在后台推进 请稍后查看时间线'
          : '已注入并落表 会话非空闲 挂起至下一轮对话',
      )
      setInjectOrderNo('')
      setInjectDescription('')
      await load()
    } catch (caught) {
      setInjectError(caught instanceof Error ? caught.message : '注入失败')
    } finally {
      setInjecting(false)
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
            {rating && (
              <div>
                <div className="text-xs text-stone-500">客户评分</div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span className="text-amber-500" aria-hidden="true">
                    {'★'.repeat(rating.score)}
                    <span className="text-stone-300">{'★'.repeat(5 - rating.score)}</span>
                  </span>
                  {rating.comment && (
                    <span className="truncate text-xs text-stone-500" title={rating.comment}>
                      {rating.comment}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="mt-4 rounded-control border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        {isOperator && !loading && (
          <section className="mt-6 rounded-container border border-hairline bg-surface px-4 py-3">
            <h2 className="text-sm font-medium text-stone-700">运营操作 物流事件注入</h2>
            <p className="mt-0.5 text-xs text-stone-500">
              向会话推送物流状态变化 空闲会话即时触达 忙时会话挂起至下一轮 已签收订单不可回退
            </p>
            <form onSubmit={inject} className="mt-3 flex flex-wrap items-center gap-2">
              <label htmlFor="inject-order-no" className="sr-only">
                订单号
              </label>
              <input
                id="inject-order-no"
                value={injectOrderNo}
                onChange={(event) => setInjectOrderNo(event.target.value)}
                placeholder="订单号 如 SO-2026-0002"
                className="w-52 rounded-control border border-hairline bg-surface px-3 py-1.5 font-mono text-xs text-stone-900 transition-colors duration-200 placeholder:text-stone-400 focus:border-sage-300 focus:outline-none"
              />
              <label htmlFor="inject-status" className="sr-only">
                物流状态
              </label>
              <select
                id="inject-status"
                value={injectStatus}
                onChange={(event) => setInjectStatus(event.target.value as 'delayed' | 'lost')}
                className="rounded-control border border-hairline bg-surface px-3 py-1.5 text-xs text-stone-900 transition-colors duration-200 focus:border-sage-300 focus:outline-none"
              >
                <option value="delayed">运输延误</option>
                <option value="lost">包裹丢失</option>
              </select>
              <label htmlFor="inject-description" className="sr-only">
                事件描述
              </label>
              <input
                id="inject-description"
                value={injectDescription}
                onChange={(event) => setInjectDescription(event.target.value)}
                placeholder="描述 如 上海浦东分拨中心积压 预计延迟两天"
                className="min-w-64 flex-1 rounded-control border border-hairline bg-surface px-3 py-1.5 text-xs text-stone-900 transition-colors duration-200 placeholder:text-stone-400 focus:border-sage-300 focus:outline-none"
              />
              <button
                type="submit"
                disabled={injecting || !injectOrderNo.trim() || !injectDescription.trim()}
                className="shrink-0 rounded-control bg-sage-700 px-4 py-1.5 text-xs font-medium text-white transition-colors duration-200 hover:bg-sage-800 active:scale-[0.98] disabled:opacity-50"
              >
                {injecting ? '注入中' : '注入'}
              </button>
            </form>
            {injectResult && (
              <p className="mt-2 rounded-control border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800">
                {injectResult}
              </p>
            )}
            {injectError && (
              <p className="mt-2 rounded-control border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700">
                {injectError}
              </p>
            )}
          </section>
        )}

        {view.tools.length > 0 && (
          <section className="mt-6">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-stone-700">
              工具轨迹
              {view.contextCompactions > 0 && (
                <span
                  className="rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-[11px] font-normal text-teal-700"
                  title="长对话触发上下文压缩 早期工具结果已清理"
                >
                  上下文压缩 {view.contextCompactions} 次
                </span>
              )}
            </h2>
            <div className="space-y-1.5">
              {view.tools.map((tool) => (
                <ToolCard key={tool.executionId} tool={tool} />
              ))}
            </div>
          </section>
        )}

        <section className="mt-6">
          <h2 className="mb-2 text-sm font-medium text-stone-700">事件时间线</h2>
          <div className="overflow-x-auto rounded-container border border-hairline bg-surface">
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
                  <tr
                    key={event.sequence}
                    className="transition-colors duration-200 hover:bg-stone-50"
                  >
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
  if (event.type === 'logistics.event') {
    const statusText = payload.status === 'lost' ? '包裹丢失' : '运输延误'
    return `订单 ${String(payload.orderNo ?? '')} ${statusText} ${String(payload.description ?? '')}`.slice(
      0,
      100,
    )
  }
  const keys = Object.keys(payload)
  if (keys.length === 0) return ''
  const first = keys[0]!
  const value = payload[first]
  if (typeof value === 'string') return value.slice(0, 80)
  return JSON.stringify(payload).slice(0, 100)
}
