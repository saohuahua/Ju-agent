'use client'

/**
 * 运行详情页 v4 重做
 *
 * 布局从单列收窄改为全宽双栏：
 *   主栏  决策轨迹时间轴 + 节点详情 + 工具轨迹 + 原始事件表
 *   右栏  工具目录能力门控面板（常驻）
 *
 * 通过事件 JSON 端点全量重建 支持断点恢复与物流事件注入（沿袭 v3 能力）。
 * 深色控制台轨（工程侧）配色走语义 token。
 */

import { use, useMemo, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { GuardPanel } from '@/components/GuardPanel'
import { NodeDetail } from '@/components/NodeDetail'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/Skeleton'
import { StatusBadge } from '@/components/StatusBadge'
import { Timeline } from '@/components/Timeline'
import { ToolCard } from '@/components/ToolCard'
import { ToolCatalogPanel } from '@/components/ToolCatalogPanel'
import { api, currentToken } from '@/lib/api'
import { reduceEvents, initialViewState } from '@/lib/runReducer'
import { projectTimeline } from '@/lib/timeline'
import { runDetailOptions } from '@/lib/run-detail-query'
import type { AgentEvent } from '@/lib/types'

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
  'tools.catalog_changed': '工具目录变更',
  'guard.blocked': '防线拦截',
}

export default function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params)

  // 动态路由可能复用页面组件 显式按案件重建草稿和操作状态
  return <RunDetail key={runId} runId={runId} />
}

const EMPTY_EVENTS: AgentEvent[] = []

function RunDetail({ runId }: { runId: string }) {
  const client = useQueryClient()
  const detail = useQuery(runDetailOptions(client, runId))
  const run = detail.data?.run ?? null
  const events = detail.data?.events ?? EMPTY_EVENTS
  const rating = detail.data?.rating
  const [error, setError] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [showRawEvents, setShowRawEvents] = useState(false)

  // 物流事件注入表单 仅操作员与主管可见
  const isOperator = ['operator-token', 'supervisor-token'].includes(currentToken())
  const [injectOrderNo, setInjectOrderNo] = useState('')
  const [injectStatus, setInjectStatus] = useState<'delayed' | 'lost'>('delayed')
  const [injectDescription, setInjectDescription] = useState('')
  const [injecting, setInjecting] = useState(false)
  const [injectResult, setInjectResult] = useState<string | null>(null)
  const [injectError, setInjectError] = useState<string | null>(null)

  // 写后明确取消旧轮询 首次加载尚无缓存时也必须读取新的事件快照
  const load = async () => {
    await client.cancelQueries({ queryKey: ['run-detail', runId], exact: true })
    return detail.refetch()
  }
  const displayError = error ?? detail.error?.message

  // 只有事件数组变化才重建视图和时间轴 输入操作不重复回放历史
  const view = useMemo(() => reduceEvents(initialViewState(), events), [events])
  const nodes = useMemo(() => projectTimeline(events), [events])
  const hasCatalog = events.some((event) => event.type === 'tools.catalog_changed')
  const selected = nodes.find((node) => node.key === selectedKey) ?? null
  const stuck = run?.status === 'running'
  const loading = detail.isPending

  const resume = async () => {
    setError(null)
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
    <>
      <div className="page-enter px-6 py-8">
        <div className="flex items-center justify-between gap-4">
          <h1 className="flex shrink-0 items-center gap-3 text-xl font-semibold tracking-tight">
            运行详情
            {run && <StatusBadge status={run.status} />}
          </h1>
          <div className="flex min-w-0 items-center gap-4">
            <p className="truncate font-mono text-xs text-stone-500">{runId}</p>
            {stuck && (
              <Button
                loading={resuming}
                onClick={resume}
                disabled={resuming}
                className="shrink-0 rounded-control bg-amber-700 px-4 py-2 text-xs font-medium text-white transition-colors duration-200 hover:bg-amber-800 active:scale-[0.98] disabled:opacity-50"
              >
                断点恢复
              </Button>
            )}
          </div>
        </div>

        {loading && (
          <div
            className="mt-6 grid grid-cols-2 gap-x-8 gap-y-4 lg:grid-cols-4"
            role="status"
            aria-label="正在读取运行详情"
          >
            {[0, 1, 2, 3].map((index) => (
              <div key={index}>
                <Skeleton className="h-3 w-14" />
                <Skeleton className="mt-1.5 h-4 w-24" />
              </div>
            ))}
          </div>
        )}

        {!loading && run && (
          <div className="mt-6 grid grid-cols-2 gap-x-8 gap-y-4 text-sm sm:grid-cols-4">
            <MetaField label="客户" value={run.customerId} />
            <MetaField label="意图" value={run.intent ?? '-'} />
            <MetaField label="模型" value={run.model} mono />
            <MetaField label="提示词版本" value={run.promptVersion} mono />
            <MetaField label="事件数" value={String(events.length)} mono />
            <MetaField label="会话来源" value={run.source === 'sim' ? '评测模拟' : '真实客户'} />
            <MetaField label="创建时间" value={new Date(run.createdAt).toLocaleString('zh-CN')} />
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

        {displayError && (
          <p className="mt-4 rounded-control border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {displayError}
          </p>
        )}

        {/* 双栏主体：主栏时间轴与轨迹 右栏门控面板 */}
        <div
          className={`mt-6 grid items-start gap-4 ${hasCatalog ? 'xl:grid-cols-[minmax(0,1fr)_320px]' : ''}`}
        >
          <div className="min-w-0 space-y-4">
            {nodes.length > 0 ? (
              <Timeline
                nodes={nodes}
                selectedKey={selectedKey}
                onSelect={(node) => setSelectedKey(node.key)}
              />
            ) : (
              !loading && (
                <div className="flex h-24 items-center justify-center rounded-container border border-dashed border-hairline text-xs text-stone-400">
                  暂无事件
                </div>
              )
            )}

            <NodeDetail node={selected} />

            <GuardPanel events={events} />

            {view.tools.length > 0 && (
              <section>
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

            {isOperator && (
              <section className="rounded-container border border-hairline bg-surface px-4 py-3">
                <h2 className="text-sm font-medium text-stone-700">运营操作 物流事件注入</h2>
                <p className="mt-0.5 text-xs text-stone-500">
                  向会话推送物流状态变化 空闲会话即时触达 忙时会话挂起至下一轮 已签收订单不可回退
                </p>
                <form onSubmit={inject} className="mt-3 flex flex-wrap items-center gap-2">
                  <label htmlFor="inject-order-no" className="sr-only">
                    订单号
                  </label>
                  <Input
                    id="inject-order-no"
                    value={injectOrderNo}
                    onChange={(event) => setInjectOrderNo(event.target.value)}
                    placeholder="订单号 如 SO-2026-0002"
                    className="w-52 font-mono text-xs"
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
                  <Input
                    id="inject-description"
                    value={injectDescription}
                    onChange={(event) => setInjectDescription(event.target.value)}
                    placeholder="描述 如 上海浦东分拨中心积压 预计延迟两天"
                    className="min-w-64 flex-1 text-xs"
                  />
                  <Button
                    loading={injecting}
                    type="submit"
                    disabled={injecting || !injectOrderNo.trim() || !injectDescription.trim()}
                    className="shrink-0 rounded-control bg-sage-700 px-4 py-1.5 text-xs font-medium text-white transition-colors duration-200 hover:bg-sage-800 active:scale-[0.98] disabled:opacity-50"
                  >
                    注入
                  </Button>
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

            <section>
              <button
                onClick={() => setShowRawEvents(!showRawEvents)}
                aria-expanded={showRawEvents}
                className="mb-2 text-sm font-medium text-stone-700 transition-colors duration-200 hover:text-stone-900"
              >
                原始事件表 {showRawEvents ? '收起' : `展开（${events.length} 条）`}
              </button>
              {showRawEvents && (
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
              )}
            </section>
          </div>

          {hasCatalog && (
            <aside className="xl:sticky xl:top-6">
              <ToolCatalogPanel events={events} />
            </aside>
          )}
        </div>
      </div>
    </>
  )
}

function MetaField({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div>
      <div className="text-xs text-stone-500">{label}</div>
      <div className={`mt-0.5 text-stone-900 ${mono ? 'font-mono text-xs' : ''}`}>{value}</div>
    </div>
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
  if (event.type === 'tools.catalog_changed') {
    const gated = (payload.gated as string[] | undefined) ?? []
    return gated.length > 0 ? `门控 ${gated.length} 个动作工具` : '动作工具解禁'
  }
  const keys = Object.keys(payload)
  if (keys.length === 0) return ''
  const first = keys[0]!
  const value = payload[first]
  if (typeof value === 'string') return value.slice(0, 80)
  return JSON.stringify(payload).slice(0, 100)
}
