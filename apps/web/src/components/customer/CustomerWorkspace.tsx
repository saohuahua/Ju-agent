'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, ArrowUp, MessageCircle, Plus, Star } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RefreshButton } from '@/components/ui/refresh-button'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupTextarea } from '@/components/ui/input-group'
import { api, ApiError, currentModelToken } from '@/lib/api'
import { createRequestKey } from '@/lib/request-key'
import { useIdentity } from '@/lib/identity'
import { useRunEvents } from '@/lib/sse'
import { useTypewriter } from '@/lib/use-typewriter'
import type { RunRatingView, RunStatus } from '@/lib/types'
import {
  canSendCustomerMessage,
  customerError,
  customerMessageText,
  customerStatus,
  TERMINAL_STATUSES,
} from './customer-view'
import styles from './CustomerWorkspace.module.css'
import { ReturnShipmentPanel } from './ReturnShipmentPanel'
import { OrderSelectionPanel } from './OrderSelectionPanel'
import {
  customerMessages,
  customerProcessing,
  DELIVERY_LABELS,
  type PendingCustomerMessage,
} from './customer-messages'

const PROMPTS = [
  '怎么申请退货',
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
        <p>请在侧栏切换到客户身份 查看该客户自己的售后会话</p>
      </div>
    )
  }

  return <CustomerSession key={token} token={token} />
}

function CustomerSession({ token }: { token: string }) {
  const [runId, setRunId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [controlBusy, setControlBusy] = useState(false)
  const controlRequest = useRef<{
    action: 'human' | 'end_consultation'
    runId: string | null
    key: string
  } | null>(null)
  const [actionError, setActionError] = useState('')
  const [pendingMessages, setPendingMessages] = useState<PendingCustomerMessage[]>([])
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
  const sendingLock = useRef(false)

  // 身份切换会卸载整个客户会话 旧写请求返回时不能发布或清除新身份草稿
  useEffect(
    () => () => {
      selectionRevision.current += 1
    },
    [],
  )

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
  const { state, events, connected, complete } = useRunEvents(runId)
  const confirmedKeys = useRef(new Set<string>())
  confirmedKeys.current = new Set(
    state.messages.flatMap((message) => (message.requestKey ? [message.requestKey] : [])),
  )
  const selectedRun = runs.data?.runs.find((run) => run.runId === runId)
  // 历史会话先用列表状态 事件回放到达后以公开事件为准
  const status: RunStatus =
    state.lastSequence > 0 || complete ? state.status : (selectedRun?.status ?? state.status)
  const statusText =
    status === 'awaiting_input' && state.consultation === 'ready'
      ? { label: '可继续咨询', next: '您可以继续提问或结束本次咨询' }
      : customerStatus(status)
  const terminal = TERMINAL_STATUSES.includes(status)
  const newRunAvailable = health.data?.modelAvailable === true
  const messages = customerMessages(state.messages, pendingMessages, runId)
  const awaitingConfirmation = messages.some((message) => message.delivery === 'accepted')
  const canSend =
    !sending &&
    !controlBusy &&
    !awaitingConfirmation &&
    canSendCustomerMessage(runId, status, newRunAvailable)
  const processing = sending ? '正在提交您的消息' : customerProcessing({ ...state, status })
  // 最后一条助手消息仍在流式拼接时由打字机接管展示 思考气泡退场
  const lastStateMessage = state.messages[state.messages.length - 1]
  const assistantTyping =
    lastStateMessage?.role === 'assistant' && lastStateMessage.streaming === true
  // 思考气泡覆盖提交确认与运行中的全部等待期 人工会话留言不暗示智能回复
  const thinking =
    !assistantTyping &&
    !terminal &&
    status !== 'handling_human' &&
    (sending || awaitingConfirmation || status === 'running')
  // 步骤文字 运行中展示工具进度 其余等待期没有可承诺的具体动作只展示通用思考
  const thinkingText = sending || status === 'running' ? processing : '正在思考'
  const nextStep =
    status === 'awaiting_input' && !newRunAvailable
      ? '当前智能对话服务不可用 暂时不能继续处理'
      : statusText.next

  function selectRun(nextRunId: string | null) {
    if (nextRunId === runId) return
    // 同一会话离开后再返回也属于新选择 旧写请求不能覆盖当前草稿或评价
    selectionRevision.current += 1
    submission.current = null
    controlRequest.current = null
    setControlBusy(false)
    setPendingMessages([])
    sendingLock.current = false
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

  // 流式期间气泡高度持续增长 消息条数不变也要跟随 以最后一条状态消息文本长度为准
  const streamingLength = state.messages[state.messages.length - 1]?.text.length ?? 0
  const previousCount = useRef(0)
  useEffect(() => {
    if (!runId) return
    // 新消息进入用平滑滚动 流式增长用即时滚动 连续平滑动画会互相打断
    const behavior = messages.length !== previousCount.current ? 'smooth' : 'auto'
    previousCount.current = messages.length
    endRef.current?.scrollIntoView({ block: 'end', behavior })
  }, [runId, messages.length, streamingLength])

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

  /** 控制请求重试沿用原键 切换会话后的迟到结果不能跳转当前页面 */
  async function control(action: 'human' | 'end_consultation') {
    if (controlBusy || sendingLock.current) return
    const revision = selectionRevision.current
    if (
      !controlRequest.current ||
      controlRequest.current.action !== action ||
      controlRequest.current.runId !== runId
    )
      controlRequest.current = { action, runId, key: createRequestKey() }
    const key = controlRequest.current.key
    setControlBusy(true)
    setActionError('')
    try {
      const result =
        action === 'human'
          ? await api.requestHumanHelp(runId, key)
          : await api.endConsultation(runId!, key)
      if (revision !== selectionRevision.current) return
      controlRequest.current = null
      if (result.runId !== runId) selectRun(result.runId)
      void runs.refetch()
    } catch (error) {
      if (revision === selectionRevision.current)
        setActionError(error instanceof ApiError ? error.message : '操作结果尚未确认 请重试核实')
    } finally {
      if (revision === selectionRevision.current) setControlBusy(false)
    }
  }

  async function submit(selectedMessage?: string) {
    const message = (selectedMessage ?? input).trim()
    if (!message || !canSend || sendingLock.current) return
    sendingLock.current = true

    const revision = selectionRevision.current
    setSending(true)
    setActionError('')
    const controller = new AbortController()
    // 超时只代表本机未确认结果 不证明后台未受理 重试继续复用原请求键
    const timeout = setTimeout(() => controller.abort(), 30000)
    let requestKey: string | undefined
    const optimistic = status !== 'handling_human'
    try {
      // 请求准备失败也进入页面错误处理 保留草稿供重试
      if (
        !submission.current ||
        submission.current.message !== message ||
        submission.current.runId !== runId
      ) {
        submission.current = { message, runId, key: createRequestKey() }
      }
      requestKey = submission.current.key
      if (optimistic) {
        const pending: PendingCustomerMessage = {
          requestKey,
          runId,
          text: message,
          delivery: 'sending',
        }
        setPendingMessages((current) => [
          ...current.filter((item) => item.requestKey !== requestKey),
          pending,
        ])
      }
      if (!runId) {
        const created = await api.createRun(
          message,
          undefined,
          requestKey,
          health.data?.modelTransport === 'live',
          controller.signal,
        )
        if (revision !== selectionRevision.current) return
        // 创建响应只是把同一次提交绑定到新会话 不按手动切换清空本地消息
        setRunId(created.runId)
        setPendingMessages((current) =>
          current.map((item) =>
            item.requestKey === requestKey
              ? { ...item, runId: created.runId, delivery: 'accepted' }
              : item,
          ),
        )
        try {
          sessionStorage.setItem(`aftersales:selected-run:${token}`, created.runId)
        } catch {
          /* 存储不可用不影响消息确认 */
        }
        void runs.refetch()
      } else {
        const result = await api.continueRun(
          runId,
          message,
          requestKey,
          undefined,
          controller.signal,
        )
        if (revision !== selectionRevision.current) return
        // 办理中申请人工会返回关联咨询 不把人工消息留在原业务气泡里
        if (result.runId !== runId) {
          selectRun(result.runId)
          void runs.refetch()
          return
        }
        setPendingMessages((current) =>
          current.map((item) =>
            item.requestKey === requestKey ? { ...item, delivery: 'accepted' } : item,
          ),
        )
      }
      setInput('')
      submission.current = null
    } catch (error) {
      if (revision !== selectionRevision.current) return
      // 公开事件已确认受理时即使 HTTP 失败也不再把同一消息提示为未知
      if (requestKey && confirmedKeys.current.has(requestKey)) {
        setInput('')
        submission.current = null
        return
      }
      const unknown = !(error instanceof ApiError) || error.status >= 500
      if (optimistic && requestKey)
        setPendingMessages((current) =>
          current.map((item) =>
            item.requestKey === requestKey
              ? { ...item, delivery: unknown ? 'unknown' : 'failed' }
              : item,
          ),
        )
      if (selectedMessage) setInput(message)
      if (error instanceof ApiError && error.code === 'MODEL_UNAVAILABLE') {
        setActionError('当前对话服务不可用 暂时不能发起新会话')
        void health.refetch()
      } else {
        setActionError(
          unknown
            ? optimistic
              ? '发送结果尚未确认 请重试核实'
              : '发送结果尚未确认 请联系售后专员核实'
            : customerError(error, '发送失败 请检查身份或内容后重试'),
        )
      }
    } finally {
      clearTimeout(timeout)
      if (revision === selectionRevision.current) {
        sendingLock.current = false
        setSending(false)
      }
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
    <div className={`${styles.page} youju-motion-enter`}>
      <div className={styles.pageHeading}>
        <div>
          <h1>客户服务</h1>
          <p>
            {health.data?.conversationMode === 'durable_refund_simulation'
              ? health.data.modelTransport === 'live' && currentModelToken()
                ? '真实模型对话已启用 订单与支付为模拟 不会发生真实资金交易'
                : '售后服务已就绪 订单与支付为模拟 不会发生真实资金交易'
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
            <RefreshButton variant="link" size="sm" onRefresh={() => health.refetch()}>
              重试
            </RefreshButton>
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
            <RefreshButton
              variant="ghost"
              size="icon-sm"
              title="刷新会话"
              aria-label="刷新会话"
              disabled={runs.isFetching}
              onRefresh={() => runs.refetch()}
            />
          </div>
          {runs.isPending && (
            <div className="space-y-3 p-4" role="status" aria-label="正在读取会话">
              <span className="sr-only">正在读取会话</span>
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}
          {runs.isError && (
            <div className={styles.historyState}>
              <p>会话加载失败</p>
              <RefreshButton variant="link" size="sm" onRefresh={() => runs.refetch()}>
                重试
              </RefreshButton>
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
                  <span>售后咨询</span>
                  <span>
                    {run.runId === runId ? statusText.label : customerStatus(run.status).label}
                  </span>
                </span>
                <time dateTime={run.createdAt}>
                  {new Intl.DateTimeFormat('zh-CN', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  }).format(new Date(run.createdAt))}
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
                <p>{runId || sending ? processing || nextStep : '请描述您遇到的问题'}</p>
              </div>
            </div>
            {runId && <Badge variant="secondary">{statusText.label}</Badge>}
          </header>

          <div className={styles.thread} aria-live="polite" aria-relevant="additions text">
            {state.sourceRunId && (
              <Button variant="link" onClick={() => selectRun(state.sourceRunId)}>
                查看关联售后记录
              </Button>
            )}
            {!runId && messages.length === 0 && (
              <div className={styles.welcome}>
                <span className={styles.welcomeIcon}>
                  <MessageCircle aria-hidden="true" />
                </span>
                <h3>您好 请告诉我们遇到了什么问题</h3>
                <p>不记得订单号也没关系 描述问题后可以选择您最近的订单</p>
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

            {runId && messages.length === 0 && !complete && (
              <p className={styles.threadState}>
                {connected ? '正在等待服务消息' : '正在读取会话记录'}
              </p>
            )}
            {runId && messages.length === 0 && complete && (
              <p className={styles.threadState}>这段会话暂时没有公开消息</p>
            )}
            {messages.map((message, index) => (
              <article
                key={message.requestKey ?? `${runId}-${index}`}
                className={`${styles.message} youju-motion-enter`}
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
                  <p className={styles.bubble} aria-busy={message.streaming || undefined}>
                    {message.role === 'user' ? (
                      customerMessageText(message.text, events)
                    ) : (
                      <AssistantStreamText text={message.text} streaming={message.streaming} />
                    )}
                    {message.streaming && <span className={styles.streaming}>正在回复</span>}
                  </p>
                  {message.delivery && (
                    <span className={styles.delivery} role="status">
                      {DELIVERY_LABELS[message.delivery]}
                    </span>
                  )}
                </div>
              </article>
            ))}
            {/* 思考气泡 助手未开始输出但流程在推进时展示 三个跳点加上当前步骤文字 */}
            {runId && thinking && (
              <article className={`${styles.message} youju-motion-enter`} data-role="assistant">
                <span className={styles.messageAvatar} aria-hidden="true">
                  据
                </span>
                <div className={styles.messageBody}>
                  <strong>有据售后助手</strong>
                  <p className={styles.bubble}>
                    <span className="youju-thinking-dots" role="status" aria-label="正在思考">
                      <i />
                      <i />
                      <i />
                    </span>
                    {/* 步骤文字变化时重挂载 用入场动画完成过渡 */}
                    <span
                      key={thinkingText}
                      className={`${styles.thinkingStep} youju-motion-enter`}
                    >
                      {thinkingText}
                    </span>
                  </p>
                </div>
              </article>
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
            {runId && status === 'awaiting_input' && state.orderCandidates && (
              <OrderSelectionPanel
                candidates={state.orderCandidates}
                disabled={!canSend}
                onSelect={(message) => {
                  void submit(message)
                }}
              />
            )}
            {state.showChoices && status === 'awaiting_input' && (
              <div className="flex flex-wrap gap-2" aria-label="请选择需要的帮助">
                {['我要申请退货退款', '我想查询订单物流', '我想咨询售后政策'].map((choice) => (
                  <Button
                    key={choice}
                    variant="outline"
                    disabled={!canSend}
                    onClick={() => void submit(choice)}
                  >
                    {choice}
                  </Button>
                ))}
              </div>
            )}
            <div ref={endRef} />
          </div>

          {runId && !connected && !complete && (
            <div className={styles.statusRow} role="status">
              <span className={styles.connectionDot} />
              {state.lastSequence > 0 ? '连接中断 正在恢复消息' : '正在连接会话'}
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
                  <Input
                    id="rating-comment"
                    maxLength={200}
                    value={ratingComment}
                    onChange={(event) => setRatingComment(event.target.value)}
                    placeholder="还想说些什么 可选"
                    className={styles.ratingInput}
                  />
                  <Button
                    size="sm"
                    loading={ratingBusy}
                    disabled={ratingScore < 1 || ratingBusy}
                    onClick={submitRating}
                  >
                    提交评价
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

          <div className="flex flex-wrap items-center gap-2 px-4 py-2" aria-label="服务操作">
            {!['escalated', 'handling_human'].includes(status) && (
              <Button
                variant="outline"
                size="sm"
                disabled={controlBusy || sending}
                onClick={() => void control('human')}
              >
                申请人工帮助
              </Button>
            )}
            {runId && status === 'awaiting_input' && state.consultation && (
              <Button
                variant="ghost"
                size="sm"
                disabled={controlBusy || sending}
                onClick={() => void control('end_consultation')}
              >
                结束咨询
              </Button>
            )}
            {runId && terminal && (
              <Button variant="outline" size="sm" onClick={() => selectRun(null)}>
                新建咨询
              </Button>
            )}
          </div>
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
            <InputGroup>
              <InputGroupTextarea
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
                        ? state.consultation === 'ready'
                          ? '继续描述您的问题'
                          : '请补充所需信息'
                        : nextStep
                      : status === 'handling_human'
                        ? '给售后专员留言'
                        : nextStep
                }
              />
              <InputGroupAddon>
                <Button
                  type="submit"
                  size="sm"
                  loading={sending}
                  disabled={!canSend || !input.trim()}
                >
                  发送
                  <ArrowUp data-icon="inline-end" />
                </Button>
              </InputGroupAddon>
            </InputGroup>
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

/**
 * 助手气泡文本 打字机只在流式期间逐字追赶
 * 完成帧直接吸附权威文本 历史消息不走动画
 */
function AssistantStreamText({ text, streaming }: { text: string; streaming?: boolean }) {
  const shown = useTypewriter(text, streaming === true)
  return <>{shown}</>
}
