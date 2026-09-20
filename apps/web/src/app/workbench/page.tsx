'use client'

/**
 * 会话工作台
 *
 * 面向客户的售后对话界面
 * 事件流驱动渲染 补问时开放输入 审批时展示卡片 终态锁定
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AppShell } from '@/components/AppShell'
import { ApprovalCard } from '@/components/ApprovalCard'
import { StatusBadge } from '@/components/StatusBadge'
import { ToolCard } from '@/components/ToolCard'
import { api, ApiError } from '@/lib/api'
import { useRunEvents } from '@/lib/sse'

export default function WorkbenchPage() {
  const [runId, setRunId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modelAvailable, setModelAvailable] = useState(true)
  const { state, connected } = useRunEvents(runId)
  const messageEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api
      .health()
      .then((info) => setModelAvailable(info.modelAvailable))
      .catch(() => setModelAvailable(false))
  }, [])

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [state.messages.length, state.tools.length])

  const submit = useCallback(
    async (message: string) => {
      if (!message.trim() || sending) return
      setSending(true)
      setError(null)
      try {
        if (!runId) {
          const created = await api.createRun(message)
          setRunId(created.runId)
        } else if (state.status === 'awaiting_input') {
          await api.continueRun(runId, message)
        } else {
          setError('当前会话不在等待输入 请刷新或新建会话')
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

  const awaitingInput = runId !== null && state.status === 'awaiting_input'
  const terminal = ['completed', 'failed', 'cancelled', 'escalated'].includes(state.status)

  return (
    <AppShell>
      <div className="flex h-screen flex-col">
        <header className="flex items-center justify-between border-b border-slate-800 px-6 py-3">
          <div>
            <h1 className="text-sm font-semibold">售后会话</h1>
            <p className="text-xs text-slate-400">
              自然语言发起查单 退货 退款 高风险动作将进入人工审批
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {runId && <span className="font-mono text-slate-500">{runId}</span>}
            {runId && <StatusBadge status={state.status} />}
            {runId && (
              <span className={connected ? 'text-emerald-400' : 'text-amber-400'}>
                {connected ? '已连接' : '重连中'}
              </span>
            )}
            {runId && terminal && (
              <button
                onClick={() => {
                  setRunId(null)
                  setInput('')
                }}
                className="rounded-md border border-slate-700 px-2.5 py-1 text-slate-300 hover:bg-slate-800"
              >
                新会话
              </button>
            )}
          </div>
        </header>

        {!modelAvailable && (
          <div className="border-b border-amber-900/50 bg-amber-950/40 px-6 py-2 text-xs text-amber-200">
            未配置 ANTHROPIC_API_KEY 对话能力不可用 审批中心 运行记录与评测看板不受影响
          </div>
        )}

        <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
          {!runId && (
            <div className="mx-auto max-w-xl pt-16 text-center">
              <div className="text-2xl font-semibold">您好 我是售后专员 Copilot</div>
              <p className="mt-2 text-sm text-slate-400">
                可以查订单 查物流 解释政策 也可以直接发起退货退款
                <br />
                试试 订单 SO-2026-0003 不想要了 退货
              </p>
              <div className="mt-6 grid gap-2">
                {[
                  '订单 SO-2026-0002 到哪了',
                  '订单 SO-2026-0009 没发货 申请退款',
                  '退货政策是什么',
                ].map((sample) => (
                  <button
                    key={sample}
                    onClick={() => submit(sample)}
                    className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 text-left text-sm text-slate-200 hover:border-sky-600 hover:bg-slate-800"
                  >
                    {sample}
                  </button>
                ))}
              </div>
            </div>
          )}

          {state.messages.map((message, index) => (
            <div
              key={index}
              className={`max-w-2xl rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                message.role === 'user'
                  ? 'ml-auto bg-sky-600 text-white'
                  : message.role === 'assistant'
                    ? 'bg-slate-800 text-slate-100'
                    : 'mx-auto bg-transparent text-center text-xs text-slate-500'
              }`}
            >
              {message.text}
              {message.streaming && <span className="ml-1 animate-pulse">▍</span>}
            </div>
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

          {state.error && (
            <div className="max-w-2xl rounded-lg border border-red-900 bg-red-950/40 px-4 py-2 text-sm text-red-300">
              {state.error}
            </div>
          )}
          <div ref={messageEndRef} />
        </div>

        <footer className="border-t border-slate-800 px-6 py-4">
          {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
          <form
            onSubmit={(event) => {
              event.preventDefault()
              submit(input)
            }}
            className="flex gap-2"
          >
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={!runId || (!awaitingInput && !terminal)}
              placeholder={
                runId ? (awaitingInput ? '请补充信息' : '会话进行中') : '请描述您的售后需求'
              }
              className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={sending || !runId || !awaitingInput}
              className="rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              发送
            </button>
          </form>
        </footer>
      </div>
    </AppShell>
  )
}
