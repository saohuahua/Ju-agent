'use client'

import { NavigationLink as Link } from '@/components/NavigationLink'
import { useRef, useState, type CSSProperties } from 'react'
import {
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { ArrowLeft, FileText, Send, PanelRightOpen, MoreHorizontal } from 'lucide-react'

import { StatusBadge } from '@/components/StatusBadge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { RefreshButton } from '@/components/ui/refresh-button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { deskApi, type DeskCase, type PolicyDocument } from '@/lib/desk-api'
import { ATTENTION_STATUSES, deskTime, orderStatusLabel } from '@/lib/desk-format'
import { useIdentity } from '@/lib/identity'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import { useRunEvents } from '@/lib/sse'
import { cn } from '@/lib/utils'
import { DeskEmpty } from './DeskEmpty'
import { PolicyDialog } from './PolicyDialog'
import { AgentPanel } from './AgentPanel'
import { SplitHandle } from './SplitHandle'

type DraftMode = 'note' | 'reply' | 'resolve'
type CaseDraft = { mode: DraftMode; note: string; reply: string; resolve: string }
const emptyDraft = (): CaseDraft => ({ mode: 'note', note: '', reply: '', resolve: '' })

const MESSAGE_ROLES = {
  user: '客户',
  assistant: '有据 Agent',
  operator: '售后专员',
  system: '系统',
}

/** 错误保留服务端说明以便用户区分权限冲突与网络故障 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败 请稍后重试'
}

/**
 * 工作台只在团队身份下挂载查询与事件订阅
 * 案件选择属于当前身份的临时状态并随身份子树一起销毁
 */
export function CaseWorkspace() {
  const { role } = useIdentity()

  if (role === 'customer') {
    return (
      <DeskEmpty
        title="这是售后团队工作台"
        description="请从客户服务入口查看自己的会话 或切换到售后专员身份"
      />
    )
  }

  return <StaffWorkspace />
}

function StaffWorkspace() {
  const [drafts, setDrafts] = useState(new Map<string, CaseDraft>())
  const workspace = useRef<HTMLDivElement>(null)
  const [queueWidth, setQueueWidth] = useState(280)
  const [agentPercent, setAgentPercent] = useState(42)
  const [agentHidden, setAgentHidden] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const query = useDebouncedValue(search.trim(), 250)
  const cases = useInfiniteQuery({
    queryKey: ['desk', 'cases', query, filter],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => deskApi.cases({ query, filter, cursor: pageParam }, signal),
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 5000,
  })

  // 搜索由服务端覆盖全库 统计只描述当前加载页
  // 筛选状态在翻页间可能变化 因此按运行编号去重
  const loaded = [
    ...new Map(
      cases.data?.pages.flatMap((page) => page.cases).map((item) => [item.runId, item]) ?? [],
    ).values(),
  ]
  const visible = loaded

  // 不回退到另一案件避免筛选或刷新后误将回复发送给不同客户
  const selected = visible.find((item) => item.runId === selectedId)

  return (
    <div className="youju-desk desk-compact">
      <header className="youju-desk-toolbar">
        <h1>处理工作台</h1>
        <div className="youju-desk-counts" aria-label="已加载案件统计">
          <span>
            已加载 <strong>{loaded.length}</strong>
          </span>
          <span>
            需关注{' '}
            <strong>{loaded.filter((item) => ATTENTION_STATUSES.has(item.status)).length}</strong>
          </span>
          <span>
            人工处理中{' '}
            <strong>{loaded.filter((item) => item.status === 'handling_human').length}</strong>
          </span>
        </div>
        <RefreshButton
          variant="outline"
          size="sm"
          onRefresh={() => cases.refetch()}
          disabled={cases.isFetching}
        >
          刷新案件
        </RefreshButton>
      </header>

      {cases.error && (
        <Alert variant="destructive">
          <AlertDescription>{errorText(cases.error)} · 可点击刷新重试</AlertDescription>
        </Alert>
      )}

      <div
        ref={workspace}
        className={cn(
          'youju-workspace',
          selected && 'has-selection',
          agentHidden && 'agent-hidden',
        )}
        style={
          {
            '--queue-width': `${queueWidth}px`,
            '--agent-fr': `${agentPercent}fr`,
            '--conversation-fr': `${100 - agentPercent}fr`,
          } as CSSProperties
        }
      >
        <aside
          className="youju-queue"
          aria-label="案件队列"
          aria-busy={search.trim() !== query || cases.isFetching}
        >
          <div className="youju-queue-tools">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="case-search">搜索案件</FieldLabel>
                <Input
                  id="case-search"
                  placeholder="客户 问题或会话编号"
                  value={search}
                  maxLength={200}
                  onChange={(event) => {
                    setSearch(event.target.value)
                    setSelectedId(null)
                  }}
                />
              </Field>
            </FieldGroup>
            <Tabs
              value={filter}
              onValueChange={(value) => {
                setFilter(value)
                setSelectedId(null)
              }}
            >
              <TabsList aria-label="案件状态筛选">
                <TabsTrigger value="all">全部</TabsTrigger>
                <TabsTrigger value="attention">需关注</TabsTrigger>
                <TabsTrigger value="active">处理中</TabsTrigger>
              </TabsList>
            </Tabs>
            <p>{visible.length} 个案件 · 按创建时间排序</p>
          </div>

          {cases.isPending ? (
            <div className="youju-loading" role="status" aria-label="正在读取案件列表">
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          ) : visible.length === 0 ? (
            <DeskEmpty
              title="暂无匹配案件"
              description="调整筛选条件 或在客户入口提交新的售后问题"
            />
          ) : (
            visible.map((item) => (
              <button
                key={item.runId}
                className={cn('youju-case-row', selected?.runId === item.runId && 'selected')}
                aria-pressed={selected?.runId === item.runId}
                disabled={search.trim() !== query}
                title={`${item.title || '尚未收到客户消息'} · ${item.customerName || item.customerId}`}
                onClick={() => setSelectedId(item.runId)}
              >
                <h2>{item.title || '尚未收到客户消息'}</h2>
                <div className="desk-queue-meta">
                  <span className="desk-case-id" title={item.runId}>
                    {item.runId}
                  </span>
                  <span title={item.intent ?? '未识别'}>{item.intent || '未识别'}</span>
                  <StatusBadge status={item.status} />
                </div>
                <footer>
                  <span>
                    {item.source === 'sim' ? '评测 · ' : ''}
                    {item.customerName || item.customerId}
                  </span>
                  <time dateTime={item.createdAt}>{deskTime(item.createdAt)}</time>
                </footer>
              </button>
            ))
          )}
          {cases.hasNextPage && (
            <div className="youju-queue-tools">
              <Button
                variant="outline"
                disabled={cases.isFetching}
                loading={cases.isFetchingNextPage}
                onClick={() => void cases.fetchNextPage()}
              >
                加载更多案件
              </Button>
            </div>
          )}
        </aside>

        <SplitHandle
          label="调整工单队列宽度"
          value={queueWidth}
          min={220}
          max={380}
          onDelta={(delta) => setQueueWidth((value) => Math.max(220, Math.min(380, value + delta)))}
        />
        {selected ? (
          <CaseDetail
            key={selected.runId}
            item={selected}
            onBack={() => setSelectedId(null)}
            drafts={drafts}
            onUpdateDraft={(runId, update) =>
              setDrafts((current) => {
                const next = new Map(current)
                next.set(runId, update(current.get(runId) ?? emptyDraft()))
                return next
              })
            }
            agentHidden={agentHidden}
            onToggleAgent={() => setAgentHidden((value) => !value)}
            agentPercent={agentPercent}
            onResizeAgent={(delta) => {
              const width = (workspace.current?.clientWidth ?? 1400) - queueWidth - 10
              setAgentPercent((value) => Math.max(25, Math.min(55, value - (delta / width) * 100)))
            }}
          />
        ) : (
          <div className="youju-unselected">
            <DeskEmpty
              title="选择一个案件开始处理"
              description="会话显示在中间 Agent 执行轨迹与业务依据显示在右侧"
            />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 案件组件以运行标识为键隔离输入草稿与政策弹窗
 * 服务端读模型负责事实与归属校验 事件流负责会话增量展示
 * 内部备注与对外回复使用独立操作并在提交前绑定当前案件
 */
function CaseDetail({
  item,
  onBack,
  drafts,
  onUpdateDraft,
  agentHidden,
  onToggleAgent,
  agentPercent,
  onResizeAgent,
}: {
  item: DeskCase
  onBack: () => void
  drafts: Map<string, CaseDraft>
  onUpdateDraft: (runId: string, update: (draft: CaseDraft) => CaseDraft) => void
  agentHidden: boolean
  onToggleAgent: () => void
  agentPercent: number
  onResizeAgent: (delta: number) => void
}) {
  const client = useQueryClient()
  const detail = useQuery({
    queryKey: ['desk', item.runId],
    queryFn: ({ signal }) => deskApi.detail(item.runId, signal),
    refetchInterval: 5000,
  })
  const { state, connected, complete, events } = useRunEvents(item.runId)
  // 草稿由当前身份的工作台持有 按案件与用途隔离
  const caseDraft = drafts.get(item.runId) ?? emptyDraft()
  const mode = caseDraft.mode
  const draft = caseDraft[mode]
  const setDraft = (text: string) =>
    onUpdateDraft(item.runId, (saved) => ({ ...saved, [mode]: text }))
  const setMode = (value: DraftMode) =>
    onUpdateDraft(item.runId, (saved) => ({ ...saved, mode: value }))
  const busy = useIsMutating({ mutationKey: ['desk-action', item.runId] }) > 0
  const [document, setDocument] = useState<PolicyDocument | null>(null)
  const [notice, setNotice] = useState('')
  const status = detail.data?.run.status ?? item.status
  const canResolve = detail.data?.closure?.canResolve === true && !detail.isError

  const action = useMutation({
    mutationKey: ['desk-action', item.runId],
    mutationFn: async ({
      kind,
      text = '',
    }: {
      kind: 'note' | 'reply' | 'takeover' | 'resolve'
      text?: string
    }) => {
      if (kind === 'takeover') return api.takeOverRun(item.runId)
      if (kind === 'resolve') return api.resolveRun(item.runId, text)
      if (kind === 'reply') return api.sendOperatorMessage(item.runId, text)
      return deskApi.note(item.runId, text)
    },
    onSuccess: async (_result, input) => {
      // 异步提交只清除原案件中仍与已提交内容相同的草稿
      if (input.kind !== 'takeover') {
        const submittedMode = input.kind
        onUpdateDraft(item.runId, (saved) =>
          saved[submittedMode].trim() === (input.text ?? '')
            ? { ...saved, [submittedMode]: '' }
            : saved,
        )
      }
      setNotice(
        input.kind === 'note'
          ? '内部备注已保存 客户不可见'
          : input.kind === 'reply'
            ? '回复已发送给客户'
            : input.kind === 'resolve'
              ? '人工会话已结案'
              : '已接管案件',
      )
      await client.invalidateQueries({ queryKey: ['desk'] })
    },
    onError: async (_error, input) => {
      if (input.kind === 'resolve') await client.invalidateQueries({ queryKey: ['desk'] })
    },
  })

  return (
    <>
      <section className="youju-conversation" aria-label="案件会话">
        <header className="youju-case-heading">
          <Button variant="ghost" size="sm" onClick={onBack} className="youju-mobile-back">
            <ArrowLeft data-icon="inline-start" />
            返回队列
          </Button>
          <div className="desk-title-row">
            <h2>{detail.data?.title || item.title || '售后案件'}</h2>
            <div className="desk-case-actions">
              {status === 'escalated' && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => action.mutate({ kind: 'takeover' })}
                >
                  接管案件
                </Button>
              )}
              {status === 'handling_human' && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setMode('resolve')}
                >
                  人工结案
                </Button>
              )}
              <details className="desk-more">
                <summary aria-label="更多工单操作">
                  <MoreHorizontal size={18} />
                </summary>
                <div>
                  <Link href={`/runs/${encodeURIComponent(item.runId)}`}>完整运行记录</Link>
                  <button
                    type="button"
                    onClick={() => void detail.refetch()}
                    disabled={detail.isFetching}
                  >
                    刷新工单详情
                  </button>
                </div>
              </details>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={agentHidden ? '展开 Agent 面板' : '收起 Agent 面板'}
                onClick={onToggleAgent}
              >
                <PanelRightOpen />
              </Button>
            </div>
          </div>
          <div>
            <StatusBadge status={status} />
            <span>{complete ? '记录已同步' : connected ? '事件流已连接' : '事件流未连接'}</span>
            <span>{item.customerName || item.customerId}</span>
          </div>
          <small>
            {item.runId} · 创建于 {deskTime(item.createdAt)}
          </small>
          <details className="desk-customer-details">
            <summary>用户资料与问题描述</summary>
            <dl>
              <div>
                <dt>客户</dt>
                <dd>{item.customerName || item.customerId}</dd>
              </div>
              <div>
                <dt>客户编号</dt>
                <dd>{item.customerId}</dd>
              </div>
              <div>
                <dt>分类</dt>
                <dd>{item.intent || '未识别'}</dd>
              </div>
              <div>
                <dt>来源</dt>
                <dd>{item.source === 'sim' ? '评测会话' : '客户会话'}</dd>
              </div>
            </dl>
            <p className="desk-description-label">首条客户消息</p>
            <p>
              {state.messages.find((message) => message.role === 'user')?.text || '暂无客户描述'}
            </p>
          </details>
          {state.sourceRunId && (
            <Link href={`/runs/${encodeURIComponent(state.sourceRunId)}`}>查看关联售后记录</Link>
          )}
        </header>

        {detail.error && (
          <Alert variant="destructive">
            <AlertDescription>
              {errorText(detail.error)}{' '}
              <RefreshButton
                variant="link"
                disabled={detail.isFetching}
                onRefresh={() => detail.refetch()}
              >
                重试
              </RefreshButton>
            </AlertDescription>
          </Alert>
        )}

        <Tabs defaultValue="messages" className="youju-conversation-tabs">
          <TabsList variant="line" aria-label="会话视图">
            <TabsTrigger value="messages">会话与处理</TabsTrigger>
            <TabsTrigger value="notes">内部备注 {detail.data?.notes.length ?? 0}</TabsTrigger>
          </TabsList>
          <TabsContent value="messages" className="youju-message-list">
            {state.messages.length === 0 && (
              <DeskEmpty
                title="尚无会话消息"
                description={
                  connected ? '等待客户或处理流程产生消息' : '正在读取会话 连接失败时请刷新页面'
                }
              />
            )}
            {state.messages.map((message, index) => (
              <article
                key={index}
                className={cn('youju-message youju-motion-enter', `youju-message-${message.role}`)}
              >
                <header>
                  <span className="youju-avatar">
                    {message.role === 'assistant' ? '据' : MESSAGE_ROLES[message.role].slice(0, 1)}
                  </span>
                  <strong>{MESSAGE_ROLES[message.role]}</strong>
                  {message.streaming && (
                    <small className="youju-streaming-note">
                      <span className="youju-thinking-dots" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      正在生成
                    </small>
                  )}
                </header>
                <div>{message.text}</div>
              </article>
            ))}
            {state.error && (
              <Alert variant="destructive">
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            )}
            {status === 'awaiting_approval' && (
              <Alert>
                <AlertDescription>
                  方案正在等待主管审批 审批同意后仍需执行并核验业务结果{' '}
                  <Link href="/approvals">前往审批中心</Link>
                </AlertDescription>
              </Alert>
            )}
          </TabsContent>
          <TabsContent value="notes" className="youju-message-list">
            {!detail.data?.notes.length && (
              <DeskEmpty
                title="还没有内部备注"
                description="备注仅供团队协作 不会发送给客户或加入模型上下文"
              />
            )}
            {detail.data?.notes.map((note) => (
              <article className="youju-note" key={note.id}>
                <header>
                  {note.author} · {deskTime(note.createdAt)}
                </header>
                <p>{note.body}</p>
              </article>
            ))}
          </TabsContent>
        </Tabs>

        <form
          className="youju-composer"
          onSubmit={(event) => {
            event.preventDefault()
            if (mode === 'resolve' && !canResolve) return
            if (draft.trim() && !busy)
              action.mutate({
                kind: mode === 'note' ? 'note' : mode === 'resolve' ? 'resolve' : 'reply',
                text: draft.trim(),
              })
          }}
        >
          <Tabs
            value={mode}
            onValueChange={(value) => {
              setMode(value as DraftMode)
              setNotice('')
              action.reset()
            }}
          >
            <TabsList aria-label="编辑类型">
              <TabsTrigger value="note" disabled={busy}>
                内部备注
              </TabsTrigger>
              <TabsTrigger value="reply" disabled={busy || status !== 'handling_human'}>
                回复客户
              </TabsTrigger>
              <TabsTrigger value="resolve" disabled={busy || status !== 'handling_human'}>
                人工结案
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {/* 核验提示只属于人工处理中 终态不再显示空阻塞信息 */}
          {mode === 'resolve' && status === 'handling_human' && (
            <Alert variant={canResolve ? 'default' : 'destructive'}>
              <AlertDescription>
                {canResolve
                  ? '关联业务已核验 请确认处理结论后填写摘要'
                  : '当前不能结案 请先处理以下阻塞项'}
                {detail.data?.closure?.blockers.map((blocker) => (
                  <p key={`${blocker.resourceType}:${blocker.resourceId}`}>
                    {blocker.resourceId} · {blocker.reason}
                  </p>
                ))}
                {!detail.data?.closure && <p>尚未取得结案核验结果 请刷新后重试</p>}
              </AlertDescription>
            </Alert>
          )}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="case-draft">
                {mode === 'note'
                  ? '仅团队可见'
                  : mode === 'resolve'
                    ? '结案摘要将对客户可见'
                    : '将发送给客户'}
              </FieldLabel>
              <Textarea
                id="case-draft"
                rows={3}
                maxLength={2000}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={busy || (mode !== 'note' && status !== 'handling_human')}
                placeholder={
                  mode === 'note'
                    ? '记录核验结论或下一步安排'
                    : mode === 'resolve'
                      ? '请在核实业务处理完成后填写解决摘要'
                      : '请输入给客户的回复'
                }
              />
            </Field>
          </FieldGroup>
          {action.error && (
            <Alert variant="destructive">
              <AlertDescription>{errorText(action.error)}</AlertDescription>
            </Alert>
          )}
          <footer>
            <span role="status">
              {notice ||
                (mode === 'note'
                  ? '备注不会触发业务执行'
                  : mode === 'resolve'
                    ? '人工结案不会执行退款或补偿'
                    : '资金处理仍需走受控业务流程')}
            </span>
            <Button
              type="submit"
              loading={busy && action.variables?.kind !== 'takeover'}
              disabled={
                !draft.trim() ||
                busy ||
                (mode === 'resolve' && !canResolve) ||
                (mode !== 'note' && status !== 'handling_human')
              }
            >
              <Send data-icon="inline-start" />
              {mode === 'note' ? '保存备注' : mode === 'resolve' ? '确认结案' : '发送回复'}
            </Button>
          </footer>
        </form>
      </section>

      {!agentHidden && (
        <SplitHandle
          label="调整会话与执行面板宽度"
          value={100 - agentPercent}
          min={45}
          max={75}
          onDelta={onResizeAgent}
        />
      )}
      <AgentPanel
        key={item.runId}
        events={events}
        runId={item.runId}
        status={status}
        connected={connected}
        complete={complete}
        hidden={agentHidden}
        onClose={onToggleAgent}
      >
        <div className="youju-evidence" aria-label="订单与政策证据">
          <h2>处理进度与待办</h2>
          <p>
            <StatusBadge status={status} />
          </p>
          {status === 'awaiting_approval' && (
            <p>
              需要主管审批 <Link href="/approvals">前往审批中心</Link>
            </p>
          )}
          {status === 'escalated' && <p>等待售后专员接管案件</p>}
          {status === 'awaiting_input' && <p>等待客户补充信息</p>}
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          {detail.error && (
            <Alert variant="destructive">
              <AlertDescription>{errorText(detail.error)}</AlertDescription>
            </Alert>
          )}
          {detail.data?.closure?.blockers.map((blocker) => (
            <p key={`${blocker.resourceType}:${blocker.resourceId}`}>
              {blocker.resourceId} · {blocker.reason}
            </p>
          ))}

          <h2>案件依据</h2>
          <p>来自实际查询与检索记录</p>
          <h3>关联订单</h3>
          {detail.isPending && (
            <div role="status" aria-label="正在读取案件依据">
              <Skeleton className="h-28" />
            </div>
          )}
          {detail.data?.orders.length === 0 && <p>尚未查询到关联订单</p>}
          {detail.data?.orders.map((order) => (
            <article className="youju-evidence-card" key={order.orderNo}>
              <strong>{order.orderNo}</strong>
              <p>{orderStatusLabel(order.status)}</p>
              <b>¥ {(order.totalAmountCents / 100).toFixed(2)}</b>
              {order.items.map((product, index) => (
                <p key={index}>
                  {product.title || product.sku || '订单商品'} × {product.quantity ?? 1}
                </p>
              ))}
            </article>
          ))}
          <h3>政策与条款</h3>
          {detail.data?.policies.length === 0 && <p>尚无检索依据 不代表没有适用政策</p>}
          {detail.data?.policies.map((policy) => (
            <button
              className="youju-evidence-card youju-policy-button"
              key={policy.articleId}
              onClick={() => setDocument(policy)}
            >
              <FileText aria-hidden="true" />
              <strong>{policy.title}</strong>
              <p>版本 {policy.policyVersion}</p>
              <span>查看原文与来源</span>
            </button>
          ))}
          <p className="youju-evidence-footnote">检索命中代表候选依据 适用条件与业务结果仍需核验</p>
        </div>
      </AgentPanel>

      <PolicyDialog document={document} onClose={() => setDocument(null)} />
    </>
  )
}
