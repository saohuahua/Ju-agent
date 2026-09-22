'use client'

/**
 * 会话工作台
 *
 * 面向客户的售后对话界面
 * 事件流驱动渲染 运行后台推进 首屏即可提问 补问时开放输入 终态锁定
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AppShell } from '@/components/AppShell'
import { ApprovalCard } from '@/components/ApprovalCard'
import { LogisticsCard } from '@/components/LogisticsCard'
import { Skeleton } from '@/components/Skeleton'
import { StatusBadge } from '@/components/StatusBadge'
import { ToolCard } from '@/components/ToolCard'
import { api, ApiError } from '@/lib/api'
import { useRunEvents } from '@/lib/sse'
import type { RunRatingView } from '@/lib/types'

export default function WorkbenchPage() {
  const [runId, setRunId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modelAvailable, setModelAvailable] = useState(true)
  const [rating, setRating] = useState<RunRatingView | null>(null)
  const [ratingScore, setRatingScore] = useState(0)
  const [ratingComment, setRatingComment] = useState('')
  const [ratingBusy, setRatingBusy] = useState(false)
  const { state, connected } = useRunEvents(runId)
  const messageEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api
      .health()
      .then((info) => setModelAvailable(info.modelAvailable))
      .catch(() => setModelAvailable(false))
  }, [])

  // 会话终态后拉取既有评分 新会话重置评分状态
  useEffect(() => {
    setRating(null)
    setRatingScore(0)
    setRatingComment('')
    if (!runId) return
    api
      .getRating(runId)
      .then((body) => setRating(body.rating))
      .catch(() => undefined)
  }, [runId])

  const submitRating = async () => {
    if (!runId || ratingScore < 1 || ratingBusy) return
    setRatingBusy(true)
    setError(null)
    try {
      const body = await api.submitRating(runId, ratingScore, ratingComment.trim() || undefined)
      setRating(body.rating)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '评分提交失败')
    } finally {
      setRatingBusy(false)
    }
  }

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [state.messages.length, state.tools.length])

  const submit = useCallback(
    async (message: string) => {
      const text = message.trim()
      if (!text || sending) return
      setSending(true)
      setError(null)
      try {
        if (!runId) {
          // 创建即返回 运行在后台推进 轨迹经 SSE 实时到达
          const created = await api.createRun(text)
          setRunId(created.runId)
        } else if (state.status === 'awaiting_input' || state.status === 'handling_human') {
          // handling_human 时服务端把客户消息直接落事件 坐席端实时可见
          await api.continueRun(runId, text)
        } else {
          setError('会话正在处理中 请等待回复完成后再发送')
          return
        }
        setInput('')
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : '发送失败 请检查 API 服务')
      } finally {
        setSending(false)
      }
    },
    [runId, sending, state.status],
  )

  // escalated 已非终态 等待坐席接入后仍可对话 真终态才锁定
  const terminal = ['completed', 'failed', 'cancelled'].includes(state.status)
  const awaitingHuman = runId !== null && state.status === 'escalated'
  const awaitingInput = runId !== null && state.status === 'awaiting_input'
  const humanHandling = runId !== null && state.status === 'handling_human'
  const canInteract = runId === null || awaitingInput || humanHandling
  // 评分开放口径 全终态含升级与人工处理中
  const ratingEligible =
    runId !== null &&
    ['completed', 'failed', 'cancelled', 'escalated', 'handling_human'].includes(state.status)
  const pendingAssistant =
    (sending && runId === null) ||
    (runId !== null && state.messages.length === 0 && ['created', 'running'].includes(state.status))

  const inputPlaceholder =
    runId === null
      ? '描述您的售后需求 也可以点击下方示例'
      : awaitingInput
        ? '请补充信息'
        : humanHandling
          ? '人工坐席处理中 您可以继续留言'
          : awaitingHuman
            ? '已升级人工 等待坐席接入'
            : terminal
              ? '会话已结束 请点击右上角新会话'
              : '会话进行中 请等待回复'

  return (
    <AppShell>
      <div className="page-enter flex h-[100dvh] flex-col">
        <header className="flex items-center justify-between border-b border-hairline px-6 py-3">
          <div>
            <h1 className="text-base font-semibold tracking-tight">售后会话</h1>
            <p className="text-xs text-stone-500">
              自然语言发起查单 退货 退款 高风险动作将进入人工审批
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {runId && <span className="font-mono text-stone-400">{runId}</span>}
            {runId && <StatusBadge status={state.status} />}
            {runId && (
              <span className="inline-flex items-center gap-1.5 text-stone-500">
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full ${
                    connected ? 'bg-emerald-500' : 'bg-amber-500'
                  }`}
                />
                {connected ? '已连接' : '重连中'}
              </span>
            )}
            {runId && terminal && (
              <button
                onClick={() => {
                  setRunId(null)
                  setInput('')
                  setError(null)
                }}
                className="rounded-control border border-hairline bg-white px-2.5 py-1 text-stone-600 transition-colors duration-200 hover:bg-stone-100 hover:text-stone-900 active:scale-[0.98]"
              >
                新会话
              </button>
            )}
          </div>
        </header>

        {!modelAvailable && (
          <div className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-800">
            未配置 ANTHROPIC_API_KEY 对话能力不可用 审批中心 运行记录与评测看板不受影响
          </div>
        )}

        <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
          {!runId && (
            <div className="mx-auto max-w-xl pt-16 text-center">
              <div className="text-2xl font-semibold tracking-tight">您好 我是售后专员 Copilot</div>
              <p className="mt-2 text-sm text-stone-500">
                可以查订单 查物流 解释政策 也可以直接发起退货退款 现金红包补偿或降价价保
                <br />
                直接输入问题 或点击下方示例立即开始
              </p>
              <div className="mt-6 grid gap-2">
                {[
                  '订单 SO-2026-0002 到哪了',
                  '订单 SO-2026-0003 不想要了 退货',
                  '订单 SO-2026-0003 快递迟到了 我要补偿',
                  '订单 SO-2026-0011 的音箱降价了 退差价',
                  '退货政策是什么',
                  '生鲜食品可以七天无理由退货吗',
                ].map((sample) => (
                  <button
                    key={sample}
                    onClick={() => submit(sample)}
                    disabled={sending}
                    className="rounded-container border border-hairline bg-white px-4 py-2.5 text-left text-sm text-stone-700 transition-colors duration-200 hover:border-stone-300 hover:bg-stone-50 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {sample}
                  </button>
                ))}
              </div>
            </div>
          )}

          {pendingAssistant && (
            <div className="max-w-2xl rounded-container border border-hairline bg-white px-4 py-2.5">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="mt-2 h-4 w-1/2" />
            </div>
          )}

          {state.messages.map((message, index) => (
            <div
              key={index}
              className={`max-w-2xl rounded-container px-4 py-2.5 text-sm leading-relaxed ${
                message.role === 'user'
                  ? 'ml-auto border border-sage-200 bg-sage-100 text-sage-900'
                  : message.role === 'assistant'
                    ? 'border border-hairline bg-white text-stone-800'
                    : message.role === 'operator'
                      ? 'border border-violet-200 bg-violet-50 text-violet-900'
                      : 'mx-auto bg-transparent text-center text-xs text-stone-400'
              }`}
            >
              {message.role === 'operator' && (
                <span className="mr-1.5 inline-flex items-center rounded-badge border border-violet-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                  人工坐席
                </span>
              )}
              {message.text}
              {message.streaming && <span className="ml-1 animate-pulse">▍</span>}
            </div>
          ))}

          {state.logistics.map((item, index) => (
            <LogisticsCard key={`${item.orderNo}-${index}`} item={item} />
          ))}

          {state.tools.length > 0 && (
            <div className="max-w-2xl space-y-1.5">
              {state.tools.map((tool) => (
                <ToolCard key={tool.executionId} tool={tool} />
              ))}
            </div>
          )}

          {state.approvals.map((approval) => (
            <ApprovalCard
              key={approval.approvalId}
              approval={approval}
              runId={runId!}
              canDecide={false}
              onDecided={() => undefined}
            />
          ))}

          {/* 终态评分卡 全终态可评 一会话一评 */}
          {runId && ratingEligible && (
            <div className="max-w-2xl rounded-container border border-hairline bg-white px-4 py-3">
              {rating ? (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-amber-500" aria-hidden="true">
                    {'★'.repeat(rating.score)}
                    <span className="text-stone-300">{'★'.repeat(5 - rating.score)}</span>
                  </span>
                  <span className="text-stone-600">
                    感谢您的评价 {rating.score} 星{rating.comment ? ` 「${rating.comment}」` : ''}
                  </span>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <span className="mr-1 text-xs text-stone-500">本次服务您满意吗</span>
                    {[1, 2, 3, 4, 5].map((score) => (
                      <button
                        key={score}
                        type="button"
                        onClick={() => setRatingScore(score)}
                        aria-label={`${score} 星`}
                        className={`text-lg leading-none transition-transform duration-200 active:scale-90 ${
                          score <= ratingScore
                            ? 'text-amber-500'
                            : 'text-stone-300 hover:text-amber-300'
                        }`}
                      >
                        ★
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      value={ratingComment}
                      onChange={(event) => setRatingComment(event.target.value)}
                      maxLength={200}
                      placeholder="可选 一句话评价"
                      className="flex-1 rounded-control border border-hairline bg-white px-3 py-1.5 text-xs text-stone-800 transition-colors duration-200 placeholder:text-stone-400"
                    />
                    <button
                      type="button"
                      onClick={submitRating}
                      disabled={ratingScore < 1 || ratingBusy}
                      className="rounded-control bg-sage-700 px-3.5 py-1.5 text-xs font-medium text-white transition-colors duration-200 hover:bg-sage-800 active:scale-[0.98] disabled:opacity-50"
                    >
                      {ratingBusy ? '提交中' : '提交评价'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {state.error && (
            <div className="max-w-2xl rounded-container border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
              {state.error}
            </div>
          )}
          <div ref={messageEndRef} />
        </div>

        <footer className="border-t border-hairline px-6 py-4">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              submit(input)
            }}
            className="flex items-center gap-2"
          >
            <label htmlFor="workbench-input" className="sr-only">
              消息
            </label>
            <input
              id="workbench-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={!canInteract}
              placeholder={inputPlaceholder}
              className="flex-1 rounded-control border border-hairline bg-white px-4 py-2.5 text-sm text-stone-900 transition-colors duration-200 placeholder:text-stone-500 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={sending || !input.trim() || !canInteract}
              className="rounded-control bg-sage-700 px-5 py-2.5 text-sm font-medium text-white transition-colors duration-200 hover:bg-sage-800 active:scale-[0.98] disabled:opacity-50"
            >
              {sending ? '发送中' : '发送'}
            </button>
          </form>
          {error && (
            <p className="mt-2 rounded-control border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
        </footer>
      </div>
    </AppShell>
  )
}
