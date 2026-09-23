'use client'

/**
 * 坐席工作台
 *
 * 人工接管的收口界面 escalated 会话进收件箱 坐席查看完整轨迹
 * 接管后与客户双向对话 附解决摘要标记解决 会话回到 completed
 * 权限分离 叙事 AI 不碰终审 坐席不碰业务执行 后者仍在审批中心
 */

import { ArrowsClockwise, CheckCircle, Headset } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppShell } from '@/components/AppShell'
import { Skeleton } from '@/components/Skeleton'
import { StatusBadge } from '@/components/StatusBadge'
import { ToolCard } from '@/components/ToolCard'
import { api, ApiError, currentRole } from '@/lib/api'
import { useRunEvents } from '@/lib/sse'
import type { RunSummary } from '@/lib/types'

const INBOX_STATUSES = ['escalated', 'handling_human'] as const

export default function ConsolePage() {
  const [inbox, setInbox] = useState<RunSummary[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'takeover' | 'resolve' | null>(null)
  const [reply, setReply] = useState('')
  const [summary, setSummary] = useState('')
  const [actionNote, setActionNote] = useState<string | null>(null)
  const { state, connected } = useRunEvents(selectedRunId)
  const messageEndRef = useRef<HTMLDivElement>(null)

  // localStorage 只能在挂载后读 SSR 期按客户渲染 避免水合不一致
  const [role, setRole] = useState<'customer' | 'operator' | 'supervisor'>('customer')
  useEffect(() => {
    setRole(currentRole())
  }, [])
  const isStaff = role === 'operator' || role === 'supervisor'

  const loadInbox = useCallback(async () => {
    // 顺带同步演示身份 侧栏切换后 3 秒内本页生效
    setRole(currentRole())
    try {
      const groups = await Promise.all(INBOX_STATUSES.map((status) => api.listRuns(status)))
      const runs = groups.flatMap((group) => group.runs)
      runs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      setInbox(runs)
      setError(null)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '收件箱加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadInbox()
    const timer = setInterval(loadInbox, 3000)
    return () => clearInterval(timer)
  }, [loadInbox])

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [state.messages.length, selectedRunId])

  // 收件箱里被解决的会话自动移出选中
  useEffect(() => {
    if (selectedRunId && !inbox.some((run) => run.runId === selectedRunId)) {
      if (state.status === 'completed') {
        setActionNote(`会话 ${selectedRunId} 已解决`)
      }
      setSelectedRunId(null)
      setReply('')
      setSummary('')
    }
  }, [inbox, selectedRunId, state.status])

  const takeOver = async (runId: string) => {
    if (busy) return
    setBusy('takeover')
    setError(null)
    try {
      await api.takeOverRun(runId)
      await loadInbox()
      setActionNote('已接管 会话转入人工处理')
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '接管失败')
    } finally {
      setBusy(null)
    }
  }

  const sendReply = async () => {
    const text = reply.trim()
    if (!selectedRunId || !text || busy) return
    setBusy('resolve')
    setError(null)
    try {
      await api.sendOperatorMessage(selectedRunId, text)
      setReply('')
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '发送失败')
    } finally {
      setBusy(null)
    }
  }

  const resolve = async () => {
    const text = summary.trim()
    if (!selectedRunId || !text || busy) return
    setBusy('resolve')
    setError(null)
    try {
      await api.resolveRun(selectedRunId, text)
      setActionNote('已标记解决 会话完结')
      await loadInbox()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '标记解决失败')
    } finally {
      setBusy(null)
    }
  }

  const escalatedCount = inbox.filter((run) => run.status === 'escalated').length
  const handling = state.status === 'handling_human'

  return (
    <AppShell>
      <div className="page-enter flex h-[100dvh] flex-col">
        <header className="flex items-center justify-between border-b border-hairline px-6 py-3">
          <div className="flex items-center gap-2.5">
            <span className="rounded-control bg-violet-100 p-1.5 text-violet-700">
              <Headset size={18} weight="fill" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-base font-semibold tracking-tight">坐席工作台</h1>
              <p className="text-xs text-stone-500">AI 升级人工的会话在此收口 接管 对话 标记解决</p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="rounded-badge border border-purple-200 bg-purple-50 px-2 py-0.5 font-medium text-purple-800">
              待接管 {escalatedCount}
            </span>
            <span className="rounded-badge border border-violet-200 bg-violet-50 px-2 py-0.5 font-medium text-violet-800">
              处理中 {inbox.length - escalatedCount}
            </span>
            <button
              onClick={() => loadInbox()}
              className="inline-flex items-center gap-1 rounded-control border border-hairline bg-surface px-2.5 py-1 text-stone-600 transition-colors duration-200 hover:bg-stone-100 active:scale-[0.98]"
            >
              <ArrowsClockwise size={14} aria-hidden="true" />
              刷新
            </button>
          </div>
        </header>

        {!isStaff && (
          <div className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-800">
            当前演示身份是客户 请在左侧切换到 售后专员 或 主管 身份后再使用坐席工作台
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {/* 收件箱 */}
          <aside className="w-80 shrink-0 overflow-y-auto border-r border-hairline px-3 py-4">
            {loading ? (
              <div className="space-y-2 px-1">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : inbox.length === 0 ? (
              <div className="px-3 py-10 text-center text-xs text-stone-400">
                收件箱空闲
                <br />
                会话中客户要求转人工或政策拒赔升级后 自动进入此处
              </div>
            ) : (
              inbox.map((run) => (
                <button
                  key={run.runId}
                  onClick={() => {
                    setSelectedRunId(run.runId)
                    setActionNote(null)
                    setError(null)
                    setReply('')
                    setSummary('')
                  }}
                  className={`mb-1.5 w-full rounded-container border px-3 py-2.5 text-left transition-colors duration-200 active:scale-[0.99] ${
                    selectedRunId === run.runId
                      ? 'border-violet-300 bg-violet-50'
                      : 'border-hairline bg-surface hover:border-stone-300 hover:bg-stone-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs text-stone-500">{run.runId}</span>
                    <StatusBadge status={run.status} />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-xs text-stone-500">
                    <span>{run.customerId}</span>
                    <span>{run.updatedAt.slice(5, 16).replace('T', ' ')}</span>
                  </div>
                </button>
              ))
            )}
          </aside>

          {/* 会话面板 */}
          <section className="flex min-w-0 flex-1 flex-col">
            {!selectedRunId ? (
              <div className="flex flex-1 items-center justify-center text-sm text-stone-400">
                {actionNote ?? '从左侧选择一个会话开始处理'}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between border-b border-hairline px-6 py-3 text-xs">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-stone-400">{selectedRunId}</span>
                    <StatusBadge status={state.status} />
                    <span className="inline-flex items-center gap-1.5 text-stone-500">
                      <span
                        aria-hidden="true"
                        className={`h-1.5 w-1.5 rounded-full ${
                          connected ? 'bg-emerald-500' : 'bg-amber-500'
                        }`}
                      />
                      {connected ? '已连接' : '重连中'}
                    </span>
                  </div>
                  {state.status === 'escalated' && (
                    <button
                      onClick={() => takeOver(selectedRunId)}
                      disabled={busy !== null || !isStaff}
                      className="rounded-control bg-violet-700 px-4 py-1.5 text-sm font-medium text-white transition-colors duration-200 hover:bg-violet-800 active:scale-[0.98] disabled:opacity-50"
                    >
                      {busy === 'takeover' ? '接管中' : '接管会话'}
                    </button>
                  )}
                </div>

                <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
                  {state.messages.map((message, index) => (
                    <div
                      key={index}
                      className={`max-w-2xl rounded-container px-4 py-2.5 text-sm leading-relaxed ${
                        message.role === 'user'
                          ? 'ml-auto border border-sage-200 bg-sage-100 text-sage-900'
                          : message.role === 'assistant'
                            ? 'border border-hairline bg-surface text-stone-800'
                            : message.role === 'operator'
                              ? 'ml-auto border border-violet-200 bg-violet-50 text-violet-900'
                              : 'mx-auto bg-transparent text-center text-xs text-stone-400'
                      }`}
                    >
                      {message.role === 'operator' && (
                        <span className="mr-1.5 inline-flex items-center rounded-badge border border-violet-200 bg-surface px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                          我
                        </span>
                      )}
                      {message.role === 'user' && (
                        <span className="mr-1.5 inline-flex items-center rounded-badge border border-sage-200 bg-surface px-1.5 py-0.5 text-[10px] font-medium text-sage-700">
                          客户
                        </span>
                      )}
                      {message.text}
                      {message.streaming && <span className="ml-1 animate-pulse">▍</span>}
                    </div>
                  ))}

                  {state.tools.length > 0 && (
                    <details className="max-w-2xl rounded-container border border-hairline bg-surface px-4 py-2.5">
                      <summary className="cursor-pointer text-xs text-stone-500">
                        工具调用轨迹 {state.tools.length} 条
                      </summary>
                      <div className="mt-2 space-y-1.5">
                        {state.tools.map((tool) => (
                          <ToolCard key={tool.executionId} tool={tool} />
                        ))}
                      </div>
                    </details>
                  )}
                  <div ref={messageEndRef} />
                </div>

                {handling && (
                  <footer className="space-y-3 border-t border-hairline px-6 py-4">
                    <form
                      onSubmit={(event) => {
                        event.preventDefault()
                        sendReply()
                      }}
                      className="flex items-center gap-2"
                    >
                      <label htmlFor="console-reply" className="sr-only">
                        坐席回复
                      </label>
                      <input
                        id="console-reply"
                        value={reply}
                        onChange={(event) => setReply(event.target.value)}
                        placeholder="以坐席身份回复客户 消息实时送达客户工作台"
                        className="flex-1 rounded-control border border-hairline bg-surface px-4 py-2.5 text-sm text-stone-900 transition-colors duration-200 placeholder:text-stone-500"
                      />
                      <button
                        type="submit"
                        disabled={busy !== null || !reply.trim()}
                        className="rounded-control bg-violet-700 px-5 py-2.5 text-sm font-medium text-white transition-colors duration-200 hover:bg-violet-800 active:scale-[0.98] disabled:opacity-50"
                      >
                        发送
                      </button>
                    </form>
                    <div className="flex items-start gap-2">
                      <label htmlFor="console-summary" className="sr-only">
                        解决摘要
                      </label>
                      <textarea
                        id="console-summary"
                        value={summary}
                        onChange={(event) => setSummary(event.target.value)}
                        rows={2}
                        placeholder="解决摘要 必填 会随解决事件落库审计 客户侧可见"
                        className="flex-1 rounded-control border border-hairline bg-surface px-4 py-2.5 text-sm text-stone-900 transition-colors duration-200 placeholder:text-stone-500"
                      />
                      <button
                        onClick={resolve}
                        disabled={busy !== null || !summary.trim()}
                        className="inline-flex items-center gap-1.5 rounded-control border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm font-medium text-emerald-800 transition-colors duration-200 hover:bg-emerald-100 active:scale-[0.98] disabled:opacity-50"
                      >
                        <CheckCircle size={16} aria-hidden="true" />
                        {busy === 'resolve' ? '提交中' : '标记解决'}
                      </button>
                    </div>
                    {actionNote && (
                      <p className="rounded-control border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                        {actionNote}
                      </p>
                    )}
                  </footer>
                )}
              </>
            )}
          </section>
        </div>

        {error && (
          <div className="border-t border-red-200 bg-red-50 px-6 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    </AppShell>
  )
}
