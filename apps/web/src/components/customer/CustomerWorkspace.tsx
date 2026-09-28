'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, ArrowUp, MessageCircle, Plus, RefreshCw, Star } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api, ApiError } from '@/lib/api'
import { createRequestKey } from '@/lib/request-key'
import { useIdentity } from '@/lib/identity'
import { useRunEvents } from '@/lib/sse'
import type { RunRatingView, RunStatus } from '@/lib/types'
import {
  canSendCustomerMessage,
  customerError,
  customerStatus,
  TERMINAL_STATUSES,
} from './customer-view'
import styles from './CustomerWorkspace.module.css'
import { ReturnShipmentPanel } from './ReturnShipmentPanel'

const PROMPTS = [
  '商品收到后无法开机 我想退货',
  '我的包裹三天没有物流更新了',
  '买完发现商品降价了 能申请价保吗',
]

export function CustomerWorkspace() {
  const { token, role } = useIdentity()

  if (role !== 'customer') {
    return (
      <div className={styles.roleNotice}>
        <MessageCircle aria-hidden="true" />
        <h1>客户服务入口</h1>
        <p>请在侧栏切换到客户演示身份 查看该客户自己的售后会话</p>
      </div>
    )
  }

  return <CustomerSession key={token} token={token} />
}

function CustomerSession({ token }: { token: string }) {
  const [runId, setRunId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [actionError, setActionError] = useState('')
  const [rating, setRating] = useState<RunRatingView | null>(null)
  const [ratingScore, setRatingScore] = useState(0)
  const [ratingComment, setRatingComment] = useState('')
  const [ratingBusy, setRatingBusy] = useState(false)
  const [ratingError, setRatingError] = useState('')
  const [ratingLoading, setRatingLoading] = useState(false)
  const [ratingLoadFailed, setRatingLoadFailed] = useState(false)
  const [ratingRefresh, setRatingRefresh] = useState(0)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const selectedHistoryRef = useRef<HTMLButtonElement>(null)
  const selectionRevision = useRef(0)
  // 网络结果未知时保留同一草稿的请求键 用户重试不会新建另一条持久命令
  const submission = useRef<{ message: string; runId: string | null; key: string } | null>(null)

  // 恢复本人上次选择 服务端继续校验会话归属
  useEffect(() => {
    try {
      setRunId(sessionStorage.getItem(`aftersales:selected-run:${token}`))
    } catch {
      /* 存储不可用时仍允许手动选择 */
    }
  }, [token])

  const health = useQuery({ queryKey: ['customer', 'health'], queryFn: api.health, retry: 1 })
  const runs = useQuery({
    queryKey: ['customer', 'runs', token],
    queryFn: () => api.listRuns(),
    refetchInterval: 10000,
    retry: 1,
  })
  const { state, connected, complete } = useRunEvents(runId)
  const selectedRun = runs.data?.runs.find((run) => run.runId === runId)
  // 历史会话先用列表状态 事件回放到达后以公开事件为准
  const status: RunStatus =
    state.lastSequence > 0 || complete ? state.status : (selectedRun?.status ?? state.status)
  const statusText = customerStatus(status)
  const terminal = TERMINAL_STATUSES.includes(status)
  const newRunAvailable = health.data?.modelAvailable === true
  const canSend = !sending && canSendCustomerMessage(runId, status, newRunAvailable)
  const nextStep =
    status === 'awaiting_input' && !newRunAvailable
      ? '当前智能对话服务不可用 暂时不能继续处理'
      : statusText.next
  const connectionText = complete ? '记录已同步' : connected ? '实时连接中' : '正在连接会话'

  function selectRun(nextRunId: string | null) {
    if (nextRunId === runId) return
    // 同一会话离开后再返回也属于新选择 旧写请求不能覆盖当前草稿或评价
    selectionRevision.current += 1
    submission.current = null
    setRunId(nextRunId)
    try {
      if (nextRunId) sessionStorage.setItem(`aftersales:selected-run:${token}`, nextRunId)
      else sessionStorage.removeItem(`aftersales:selected-run:${token}`)
    } catch {
      /* 不影响手动会话切换 */
    }
    setSending(false)
    setRatingBusy(false)
    setInput('')
    setActionError('')
    setRating(null)
    setRatingScore(0)
    setRatingComment('')
    setRatingError('')
    setRatingLoadFailed(false)
    setRatingLoading(nextRunId !== null)
  }

  useEffect(() => {
    if (runId) endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [runId, state.messages.length])

  useEffect(() => {
    // 窄屏切换时让当前会话留在横向列表的可见区域
    const revealSelected = () => {
      if (window.matchMedia('(max-width: 760px)').matches) {
        selectedHistoryRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
    }

    revealSelected()
    window.addEventListener('resize', revealSelected)
    return () => window.removeEventListener('resize', revealSelected)
  }, [runId, runs.data?.runs.length])

  useEffect(() => {
    setRating(null)
    setRatingScore(0)
    setRatingComment('')
    setRatingError('')
    setRatingLoadFailed(false)
    if (!runId) return

    // 切换会话后忽略上一条评价请求的迟到结果
    let active = true
    setRatingLoading(true)
    api
      .getRating(runId)
      .then((result) => {
        if (active) setRating(result.rating)
      })
      .catch((error) => {
        if (active) setRatingLoadFailed(Boolean(customerError(error, '评价读取失败')))
      })
      .finally(() => {
        if (active) setRatingLoading(false)
      })

    return () => {
      active = false
    }
  }, [runId, ratingRefresh])

  async function submit() {
    const message = input.trim()
    if (!message || !canSend) return

    const revision = selectionRevision.current
    setSending(true)
    setActionError('')
    try {
      // 请求准备失败也进入页面错误处理 保留草稿供重试
      if (
        !submission.current ||
        submission.current.message !== message ||
        submission.current.runId !== runId
      ) {
        submission.current = { message, runId, key: createRequestKey() }
      }
      const requestKey = submission.current.key
      if (!runId) {
        const created = await api.createRun(message, undefined, requestKey)
        if (revision !== selectionRevision.current) return
        selectRun(created.runId)
        void runs.refetch()
      } else {
        await api.continueRun(runId, message, requestKey)
        if (revision !== selectionRevision.current) return
      }
      setInput('')
      submission.current = null
    } catch (error) {
      if (revision !== selectionRevision.current) return
      if (error instanceof ApiError && error.code === 'MODEL_UNAVAILABLE') {
        setActionError('当前对话服务不可用 暂时不能发起新会话')
        void health.refetch()
      } else {
        setActionError(customerError(error, '发送失败 请检查连接后重试'))
      }
    } finally {
      if (revision === selectionRevision.current) setSending(false)
    }
  }

  async function submitRating() {
    if (!runId || ratingScore < 1 || ratingBusy) return

    const revision = selectionRevision.current
    setRatingBusy(true)
    setRatingError('')
    try {
      const result = await api.submitRating(runId, ratingScore, ratingComment.trim() || undefined)
      if (revision !== selectionRevision.current) return
      setRating(result.rating)
    } catch (error) {
      if (revision !== selectionRevision.current) return
      setRatingError(customerError(error, '评价提交失败 请稍后重试'))
    } finally {
      if (revision === selectionRevision.current) setRatingBusy(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeading}>
        <div>
          <h1>客户服务</h1>
          <p>
            {health.data?.conversationMode === 'durable_refund_simulation'
              ? '本地模拟售后 可体验退款与退货流程 不会发生真实资金交易'
              : health.data?.conversationMode === 'durable_readonly_simulation'
                ? '持久只读模拟会话 支持查询与补问 业务操作转人工'
                : '关于订单 商品与配送 我们一起把问题解决'}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={!newRunAvailable || !runId}
          onClick={() => {
            selectRun(null)
            inputRef.current?.focus()
          }}
        >
          <Plus data-icon="inline-start" />
          新会话
        </Button>
      </div>

      {health.isPending && (
        <Alert className={styles.notice}>
          <AlertDescription>正在确认服务状态</AlertDescription>
        </Alert>
      )}
      {health.isError && (
        <Alert variant="destructive" className={styles.notice}>
          <AlertCircle aria-hidden="true" />
          <AlertDescription>
            暂时无法确认智能对话服务状态
            <Button variant="link" size="sm" onClick={() => void health.refetch()}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {health.data && !health.data.modelAvailable && (
        <Alert className={styles.notice}>
          <AlertCircle aria-hidden="true" />
          <AlertDescription>
            当前对话服务不可用 暂时不能发起新会话 已有人工会话仍可继续留言
          </AlertDescription>
        </Alert>
      )}

      <div className={styles.workspace}>
        <aside className={styles.history} aria-label="我的会话">
          <div className={styles.historyHeading}>
            <h2>我的会话</h2>
            <Button
              variant="ghost"
              size="icon-sm"
              title="刷新会话"
              aria-label="刷新会话"
              disabled={runs.isFetching}
              onClick={() => void runs.refetch()}
            >
              <RefreshCw aria-hidden="true" />
            </Button>
          </div>
          {runs.isPending && <p className={styles.historyState}>正在读取会话</p>}
          {runs.isError && (
            <div className={styles.historyState}>
              <p>会话加载失败</p>
              <Button variant="link" size="sm" onClick={() => void runs.refetch()}>
                重试
              </Button>
            </div>
          )}
          {runs.data?.runs.length === 0 && <p className={styles.historyState}>还没有售后会话</p>}
          <div className={styles.historyList}>
            {runs.data?.runs.map((run) => (
              <button
                key={run.runId}
                ref={run.runId === runId ? selectedHistoryRef : undefined}
                type="button"
                className={styles.historyItem}
                data-active={run.runId === runId}
                aria-current={run.runId === runId ? 'true' : undefined}
                onClick={() => selectRun(run.runId)}
              >
                <span className={styles.historyItemTop}>
                  <span>售后会话</span>
                  <span>{customerStatus(run.status).label}</span>
                </span>
                <span className={styles.historyId}>{run.runId}</span>
                <time dateTime={run.createdAt}>
                  {new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(
                    new Date(run.createdAt),
                  )}
                </time>
              </button>
            ))}
          </div>
          {runs.data?.runs.length === 50 && (
            <p className={styles.historyLimit}>当前仅显示最近 50 条会话</p>
          )}
        </aside>

        <section className={styles.conversation} aria-label="售后会话">
          <header className={styles.conversationHeading}>
            <div className={styles.conversationTitle}>
              <span className={styles.conversationIcon}>
                <MessageCircle aria-hidden="true" />
              </span>
              <div>
                <h2>有据售后服务</h2>
                <p>{runId ? nextStep : '请描述您遇到的问题'}</p>
              </div>
            </div>
            {runId && <Badge variant="secondary">{statusText.label}</Badge>}
          </header>

          <div className={styles.thread} aria-live="polite" aria-relevant="additions text">
            {!runId && (
              <div className={styles.welcome}>
                <span className={styles.welcomeIcon}>
                  <MessageCircle aria-hidden="true" />
                </span>
                <h3>您好 请告诉我们遇到了什么问题</h3>
                <p>涉及订单时 请一并提供订单编号 方便核对商品与处理条件</p>
                {newRunAvailable && (
                  <div className={styles.prompts} aria-label="常见问题">
                    {PROMPTS.map((prompt) => (
                      <Button
                        key={prompt}
                        variant="outline"
                        onClick={() => {
                          setInput(prompt)
                          inputRef.current?.focus()
                        }}
                      >
                        {prompt}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {runId && state.messages.length === 0 && !complete && (
              <p className={styles.threadState}>
                {connected ? '正在等待服务消息' : '正在读取会话记录'}
              </p>
            )}
            {runId && state.messages.length === 0 && complete && (
              <p className={styles.threadState}>这段会话暂时没有公开消息</p>
            )}
            {state.messages.map((message, index) => (
              <article
                key={`${runId}-${index}`}
                className={styles.message}
                data-role={message.role}
              >
                {message.role !== 'system' && (
                  <span className={styles.messageAvatar} aria-hidden="true">
                    {message.role === 'user' ? '我' : message.role === 'operator' ? '售' : '据'}
                  </span>
                )}
                <div className={styles.messageBody}>
                  <strong>
                    {message.role === 'user'
                      ? '您'
                      : message.role === 'operator'
                        ? '售后专员'
                        : message.role === 'assistant'
                          ? '有据售后助手'
                          : '服务进度'}
                  </strong>
                  <p className={styles.bubble}>
                    {message.text}
                    {message.streaming && <span className={styles.streaming}>正在回复</span>}
                  </p>
                </div>
              </article>
            ))}
            {runId && !complete && !connected && state.messages.length > 0 && (
              <p className={styles.threadState}>连接中断 正在尝试恢复实时消息</p>
            )}
            {runId && terminal && state.error && (
              <Alert variant="destructive" className={styles.threadAlert}>
                <AlertCircle aria-hidden="true" />
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            )}
            {runId && (
              <ReturnShipmentPanel
                key={`${token}:${runId}`}
                token={token}
                runId={runId}
                sequence={state.lastSequence}
                connected={connected}
              />
            )}
            <div ref={endRef} />
          </div>

          {runId && (
            <div className={styles.statusRow} role="status">
              <span className={styles.connectionDot} data-connected={connected || complete} />
              {connectionText}
              <span className={styles.statusNext}>{nextStep}</span>
            </div>
          )}

          {runId && terminal && (
            <section className={styles.rating} aria-label="满意度评价">
              <div>
                <h3>本次服务您满意吗</h3>
                <p>您的评价将帮助我们改进服务</p>
              </div>
              {ratingLoading ? (
                <p>正在读取评价</p>
              ) : ratingLoadFailed ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRatingRefresh((value) => value + 1)}
                >
                  评价读取失败 重试
                </Button>
              ) : rating ? (
                <p>
                  感谢您的评价 {rating.score} 星{rating.comment ? ` · ${rating.comment}` : ''}
                </p>
              ) : (
                <div className={styles.ratingForm}>
                  <div className={styles.stars} role="group" aria-label="满意度星级">
                    {[1, 2, 3, 4, 5].map((score) => (
                      <Button
                        key={score}
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        title={`${score} 星`}
                        aria-label={`${score} 星`}
                        aria-pressed={ratingScore === score}
                        onClick={() => setRatingScore(score)}
                      >
                        <Star fill={score <= ratingScore ? 'currentColor' : 'none'} />
                      </Button>
                    ))}
                  </div>
                  <label htmlFor="rating-comment" className="sr-only">
                    评价内容
                  </label>
                  <input
                    id="rating-comment"
                    maxLength={200}
                    value={ratingComment}
                    onChange={(event) => setRatingComment(event.target.value)}
                    placeholder="还想说些什么 可选"
                    className={styles.ratingInput}
                  />
                  <Button size="sm" disabled={ratingScore < 1 || ratingBusy} onClick={submitRating}>
                    {ratingBusy ? '提交中' : '提交评价'}
                  </Button>
                </div>
              )}
              {ratingError && (
                <p className={styles.errorText} role="alert">
                  {ratingError}
                </p>
              )}
            </section>
          )}

          <form
            className={styles.composer}
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <label htmlFor="customer-message" className="sr-only">
              咨询内容
            </label>
            <Textarea
              ref={inputRef}
              id="customer-message"
              value={input}
              maxLength={1000}
              disabled={!canSend}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void submit()
                }
              }}
              placeholder={
                runId === null
                  ? newRunAvailable
                    ? '描述您遇到的问题'
                    : '当前暂不能发起新的智能会话'
                  : status === 'awaiting_input'
                    ? newRunAvailable
                      ? '请补充所需信息'
                      : nextStep
                    : status === 'handling_human'
                      ? '给售后专员留言'
                      : nextStep
              }
              className={styles.messageInput}
            />
            <div className={styles.composerBottom}>
              <span>{runId ? connectionText : '涉及订单时 请提供订单编号'}</span>
              <Button type="submit" disabled={!canSend || !input.trim()}>
                {sending ? '发送中' : '发送'}
                <ArrowUp data-icon="inline-end" />
              </Button>
            </div>
            {actionError && (
              <p className={styles.errorText} role="alert">
                {actionError}
              </p>
            )}
          </form>
        </section>
      </div>
    </div>
  )
}
