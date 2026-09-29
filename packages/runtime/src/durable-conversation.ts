import { randomUUID } from 'node:crypto'
import {
  buildStepTools,
  buildOrderListToolDefinition,
  buildSystemPrompt,
  rebuildMessages,
  type AssistantBlock,
  type ChatModel,
} from '@aftersales/agent'
import {
  ToolIO,
  P7Error,
  ListMyOrdersInput,
  OrderCandidates,
  type P6Task,
  type P7Snapshot,
} from '@aftersales/contracts'
import {
  redactDeep,
  redactText,
  buildKnowledgeSnapshot,
  retrieveKnowledge,
  type AfterSaleService,
  type ApprovalService,
} from '@aftersales/domain'
import {
  ConversationJournal,
  P6TaskRepository,
  P7Ledger,
  SqliteOrderRepository,
  SqliteShipmentRepository,
  DeskRepository,
  type SqliteDatabase,
} from '@aftersales/persistence'
import { P6Worker } from './p6-worker.js'
import { P7Gateway, type P7Transport } from './p7-gateway.js'
import { p6ConfigFromP7 } from './p6-config-snapshot.js'
import { restoreP7Snapshot } from './p7-snapshot.js'
import {
  CUSTOMER_GUIDANCE_VERSION,
  customerGuidancePrompt,
  fixedCustomerReply,
  requestsHuman,
} from './customer-guidance.js'
import { P6ConversationRefundRepository } from '../../persistence/src/p6-conversation-refund.js'

interface Turn {
  blocks: AssistantBlock[]
  text: string
}
export interface DurableConversationOptions {
  snapshot: P7Snapshot
  transport(snapshot: P7Snapshot): P7Transport
  maxTurns?: number
  leaseMs?: number
  boundary?(name: string, task: P6Task): Promise<void>
}

/**
 * 普通会话的持久执行路径 复用原生模型协议与事件上下文
 * 退款动作只交给持久业务受理 不进入旧资金工作流
 * 每轮模型结果和每个工具结果分别确认 恢复从第一个未确认步骤继续
 */
export class DurableConversation {
  readonly journal: ConversationJournal
  readonly worker: P6Worker
  private stopped = true
  private loop: Promise<void> | undefined

  constructor(
    private readonly db: SqliteDatabase,
    private readonly options: DurableConversationOptions,
    private readonly refundServices?: { afterSale: AfterSaleService; approvals: ApprovalService },
  ) {
    const tasks = new P6TaskRepository(db)
    this.journal = new ConversationJournal(db, tasks)
    this.worker = new P6Worker(
      tasks,
      {
        conversation: (task, signal) => this.execute(task, signal),
        model: async () => {
          throw new Error('普通会话不可进入资金管线')
        },
        read: async () => {
          throw new Error('普通会话不可进入资金管线')
        },
        payment: {
          execute: async () => {
            throw new Error('资金执行未开放')
          },
          query: async () => {
            throw new Error('资金执行未开放')
          },
        },
        applyPayment: () => {
          throw new Error('资金执行未开放')
        },
      },
      {
        owner: `conversation-${randomUUID()}`,
        tools: ['conversation'],
        leaseMs: options.leaseMs ?? 5000,
        callTimeoutMs: 120000,
        maxAttempts: 3,
        retryDelayMs: 100,
        limits: { global: 4, customer: 1, provider: 4, tool: 4 },
      },
    )
  }

  accept(
    customerId: string,
    key: string,
    message: string,
    runId?: string,
    returnShipment?: { returnNo: string; trackingNo: string },
    snapshot: P7Snapshot = this.options.snapshot,
  ) {
    return this.journal.accept(
      customerId,
      key,
      message,
      p6ConfigFromP7(snapshot),
      runId,
      returnShipment,
    )
  }

  owns(runId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM p6_tasks WHERE run_id = ? AND tool = 'conversation'")
        .get(runId),
    )
  }

  /** 人工申请与结束咨询使用本地持久命令 不要求供应商凭据可用 */
  control(customerId: string, key: string, action: 'human' | 'end_consultation', runId?: string) {
    return this.journal.control(
      customerId,
      key,
      action,
      p6ConfigFromP7(this.options.snapshot),
      runId,
    )
  }

  /** 单进程串行扫描 多进程竞争交给仓储租约 停止时不清空任务或费用 */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.loop = (async () => {
      while (!this.stopped) {
        try {
          await this.worker.runOnce()
        } catch (error) {
          console.error('持久会话扫描失败', error)
        }
        if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, 100))
      }
    })()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.loop
  }

  private async execute(task: P6Task, signal: AbortSignal): Promise<void> {
    const snapshot = restoreP7Snapshot(task.input.config.value)
    const gateway = new P7Gateway(snapshot, new P7Ledger(this.db))
    const guidance = snapshot.toolVersion === CUSTOMER_GUIDANCE_VERSION
    const history = this.journal.events(task.runId)
    const latestMessage = history.filter((event) => event.type === 'message.user').at(-1)
      ?.payload as { text?: string; replyToToolCallId?: string } | undefined
    // 固定话术也写入模型上下文并使用原租约确认边界
    const human = guidance && requestsHuman(latestMessage?.text ?? '')
    const fixed = guidance
      ? fixedCustomerReply(latestMessage?.text ?? '', Boolean(latestMessage?.replyToToolCallId))
      : undefined
    if (human || fixed) {
      const text = human ? '已申请人工帮助 请等待售后专员接管' : fixed!
      this.journal.commit(task, 'fixed-reply', { text }, () => {
        this.journal.append(task.runId, 'agent.turn', {
          blocks: [{ type: 'text', text }],
          stopReason: 'end_turn',
        })
        this.journal.append(task.runId, 'message.completed', { role: 'assistant', text })
      })
      this.journal.finish(task, human ? 'escalated' : 'awaiting_input', {
        summary: text,
        consultation: 'ready',
      })
      return
    }
    // 旧只读快照恢复时不能因组合根升级而悄悄获得退款能力
    const orderSelectionEnabled = snapshot.toolVersion === 'refund-orders-v2' || guidance
    const refundsEnabled = Boolean(
      this.refundServices && (snapshot.toolVersion === 'refund-v1' || orderSelectionEnabled),
    )
    const names = new Set([
      'get_order',
      'get_shipment',
      'search_policy',
      'ask_user',
      'conclude',
      'escalate',
      ...(refundsEnabled ? ['submit_refund_only', 'submit_return'] : []),
    ])
    const tools = buildStepTools({
      actions: refundsEnabled ? ['escalate', 'submit_refund_only', 'submit_return'] : ['escalate'],
    }).filter((tool) => names.has(tool.name))
    if (orderSelectionEnabled) tools.push(buildOrderListToolDefinition())
    if (guidance) {
      const conclude = tools.find((tool) => tool.name === 'conclude')!
      conclude.description =
        '本轮咨询已答复 用户仍可继续咨询 没有单独答复正文时 summary 会直接展示给客户 必须写明完整结论和核实依据 不代表业务结案'
      const orders = tools.find((tool) => tool.name === 'list_my_orders')!
      orders.description =
        '仅在需要查询具体订单或办理售后且缺少订单号时查询本人最近订单 普通政策咨询不需要选单'
    }
    for (let step = 1; step <= (this.options.maxTurns ?? 12); step++) {
      signal.throwIfAborted()
      let turn = this.journal.tasks.step(task.taskId, `turn:${step}`) as Turn | undefined
      if (!turn) {
        try {
          const model = gateway.chatModel(
            task.runId,
            'main_agent',
            this.options.transport(snapshot),
            signal,
            JSON.stringify([task.commandId, 'turn', step, 'claim', task.attempt]),
          )
          turn = await this.collect(model, {
            system: guidance
              ? customerGuidancePrompt(task.customerId, new Date().toISOString())
              : buildSystemPrompt({
                  customerId: task.customerId,
                  currentTime: new Date().toISOString(),
                }) +
                (refundsEnabled
                  ? '\n本入口支持仅退款及退货退款 查证并补齐槽位后调用对应动作 补偿价保换货取消应升级人工 禁止声称资金已经成功 动作等待和资金结果由系统通知'
                  : '\n本入口仅提供查询与解释 涉及退款补偿价保或业务操作请升级人工 禁止宣称已经执行资金动作'),
            messages: rebuildMessages(this.journal.events(task.runId)),
            tools,
          })
          const used = new Set(
            this.journal
              .events(task.runId)
              .filter((event) => event.type === 'agent.turn')
              .flatMap((event) => (event.payload as Turn).blocks)
              .filter((block) => block.type === 'tool_use')
              .map((block) => block.toolCallId),
          )
          if (turn.blocks.some((block) => block.type === 'tool_use' && used.has(block.toolCallId)))
            throw new P7Error('PROTOCOL')
        } catch (error) {
          // 网关已管理供应商尝试 不让 Worker 再套一轮模型重试
          if (error instanceof P7Error)
            this.journal.tasks.fenced(task, () => {
              this.journal.append(task.runId, 'message.completed', {
                role: 'assistant',
                text:
                  error.code === 'PROTOCOL'
                    ? '模型返回了未支持或无效的工具调用 已停止处理 请联系人工核验'
                    : '模型调用未能完成 已停止处理 请联系人工核验',
              })
              this.journal.tasks.finish(task, 'call_failed', '模型调用失败 请联系人工核验')
            })
          throw error
        }
        await this.options.boundary?.('after-model-response', task)
        const confirmed = turn
        this.journal.commit(task, `turn:${step}`, turn, () => {
          this.journal.append(task.runId, 'agent.turn', {
            blocks: confirmed.blocks,
            stopReason: confirmed.blocks.some((block) => block.type === 'tool_use')
              ? 'tool_use'
              : 'end_turn',
          })
          if (
            confirmed.text &&
            !confirmed.blocks.some(
              (block) =>
                block.type === 'tool_use' &&
                ['submit_refund_only', 'submit_return', ...(guidance ? ['ask_user'] : [])].includes(
                  block.toolName,
                ),
            )
          )
            this.journal.append(task.runId, 'message.completed', {
              role: 'assistant',
              text: confirmed.text,
            })
        })
        await this.options.boundary?.('after-turn-checkpoint', task)
      }
      const calls = turn.blocks.filter(
        (block): block is Extract<AssistantBlock, { type: 'tool_use' }> =>
          block.type === 'tool_use',
      )
      const terminal = calls.filter((call) =>
        ['ask_user', 'conclude', 'escalate'].includes(call.toolName),
      )
      const actions = calls.filter((call) =>
        ['submit_refund_only', 'submit_return'].includes(call.toolName),
      )
      if (actions.length && calls.length !== 1) throw new Error('退款动作必须单独调用')
      // 终止协议工具必须独占一轮 防止同时出现补问和未完成工具结果
      if (terminal.length && calls.length !== 1) throw new Error('终止工具必须单独调用')
      if (!calls.length || terminal.length) {
        const call = terminal[0]
        const status =
          call?.toolName === 'conclude'
            ? guidance
              ? 'awaiting_input'
              : 'completed'
            : call?.toolName === 'escalate'
              ? 'escalated'
              : 'awaiting_input'
        const question =
          call?.toolName === 'ask_user' && typeof call.input.question === 'string'
            ? redactText(call.input.question)
            : turn.text
        const pauses = this.journal
          .events(task.runId)
          .filter((event) => event.type === 'run.paused')
        const previousPause = pauses.at(-1)?.payload as { missingSlot?: string } | undefined
        const showChoices =
          guidance &&
          call?.toolName === 'ask_user' &&
          call.input.missingSlot === 'intent' &&
          previousPause?.missingSlot === 'intent'
        this.journal.tasks.fenced(task, () => {
          // conclude 在新版是轮次结束 补齐协议结果后下一轮才能继续调用真实模型
          if (guidance && call?.toolName === 'conclude') {
            this.journal.append(task.runId, 'agent.tool_results', {
              results: [
                {
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                  content: '本轮答复完成 可以继续咨询',
                  isError: false,
                },
              ],
            })
            if (!turn.text && typeof call.input.summary === 'string')
              this.journal.append(task.runId, 'message.completed', {
                role: 'assistant',
                text: redactText(call.input.summary),
              })
          }
          if (call?.toolName === 'ask_user')
            this.journal.append(task.runId, 'message.completed', {
              role: 'assistant',
              text: question,
            })
          this.journal.finish(task, status, {
            summary:
              typeof call?.input.summary === 'string'
                ? redactText(call.input.summary)
                : turn.text || '已升级人工核验',
            hint: question,
            toolCallId: call?.toolName === 'ask_user' ? call.toolCallId : undefined,
            missingSlot:
              orderSelectionEnabled && call?.toolName === 'ask_user'
                ? String(call.input.missingSlot)
                : undefined,
            ...(guidance
              ? {
                  consultation:
                    call?.toolName === 'ask_user' ? ('clarify' as const) : ('ready' as const),
                  showChoices,
                }
              : {}),
          })
        })
        return
      }
      for (const call of calls) {
        const key = `tool:${step}:${call.toolCallId}`
        if (this.journal.tasks.step(task.taskId, key) !== undefined) continue
        signal.throwIfAborted()
        let output: unknown
        let isError = false
        if (actions.length && refundsEnabled && this.refundServices) {
          await this.options.boundary?.('before-business-accept', task)
          try {
            new P6ConversationRefundRepository(this.db).submit(task, key, call, this.refundServices)
          } catch (error) {
            // 受理事务回滚后才允许返回明确失败 不回退旧执行器
            this.journal.commit(task, key, { rejected: true }, () =>
              this.journal.append(task.runId, 'agent.tool_results', {
                results: [
                  {
                    toolCallId: call.toolCallId,
                    toolName: call.toolName,
                    content: JSON.stringify({
                      error: '售后申请未受理 请核对归属或现有售后并联系人工',
                      reason: error instanceof Error ? redactText(error.message) : '业务校验失败',
                    }),
                    isError: true,
                  },
                ],
              }),
            )
            continue
          }
          await this.options.boundary?.('after-business-accept', task)
          return
        }
        // 开始检查点仅记录动作展示 不代替原工具结果检查点
        // 恢复仍按原结果决定是否查询 租约围栏阻止旧所有者追加进度
        const executionId = `${task.taskId}:${key}`
        this.journal.commit(task, `${key}:started`, { executionId }, () => {
          this.journal.append(task.runId, 'tool.requested', {
            executionId,
            toolName: call.toolName,
            attempt: task.attempt,
            args: {},
          })
        })
        try {
          output = await this.read(
            call.toolName,
            call.input,
            task.customerId,
            snapshot.knowledgeSnapshotId,
            orderSelectionEnabled,
            guidance,
          )
        } catch {
          output = { error: '查询失败 请核对参数及订单归属' }
          isError = true
        }
        await this.options.boundary?.('after-read-response', task)
        const result = {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          content: JSON.stringify(redactDeep(output)),
          isError,
        }
        this.journal.commit(task, key, result, () => {
          if (call.toolName === 'list_my_orders' && !isError)
            this.journal.append(task.runId, 'order.candidates', output)
          if (orderSelectionEnabled && call.toolName === 'get_order' && !isError)
            this.journal.append(
              task.runId,
              'order.candidates',
              OrderCandidates.parse({
                orders: [output],
                offset: 0,
                nextOffset: null,
              }),
            )
          this.journal.append(task.runId, 'agent.tool_results', { results: [result] })
          this.journal.append(task.runId, 'tool.completed', {
            executionId,
            toolName: call.toolName,
            status: isError ? 'failed' : 'succeeded',
            result: redactDeep(output),
          })
          // 政策引用沿用工作台审计关联 只记录已确认返回的文档标识
          if (call.toolName === 'search_policy' && !isError) {
            const articles = (output as { articles: Array<{ articleId: string }> }).articles
            this.db
              .prepare(
                `INSERT INTO audit_logs (occurred_at, actor_role, actor_id, action, resource_type, resource_id, detail_json, run_id)
              VALUES (?, 'customer', ?, 'policy_articles_searched', 'policy', ?, ?, ?)`,
              )
              .run(
                new Date().toISOString(),
                task.customerId,
                redactText(String(call.input.query ?? '')),
                JSON.stringify({ articleIds: articles.map((article) => article.articleId) }),
                task.runId,
              )
          }
          // 工作台证据仍读取正式工具记录 并与结果事件处于同一个确认事务
          this.db
            .prepare(
              `INSERT INTO tool_executions (run_id, tool_name, args_json, status, error_code, attempt, latency_ms, result_summary_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
            )
            .run(
              task.runId,
              call.toolName,
              JSON.stringify(redactDeep(call.input)),
              isError ? 'failed' : 'succeeded',
              isError ? 'VALIDATION_ERROR' : null,
              task.attempt,
              JSON.stringify(redactDeep(output)),
              new Date().toISOString(),
            )
        })
        await this.options.boundary?.('after-read-checkpoint', task)
      }
    }
    throw new Error('会话达到模型轮次上限')
  }

  /** 只收集完整且已经通过 P7 协议校验的轮次 不持久化未完成片段 */
  private async collect(
    model: ChatModel,
    request: Parameters<ChatModel['stream']>[0],
  ): Promise<Turn> {
    const blocks: AssistantBlock[] = []
    const inputs = new Map<string, string>()
    let text = ''
    let complete = false
    for await (const event of model.stream(request)) {
      if (event.type === 'text_delta') text += event.text
      else if (event.type === 'tool_call_start') {
        blocks.push({
          type: 'tool_use',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: {},
          ...(event.thoughtSignature ? { thoughtSignature: event.thoughtSignature } : {}),
        })
        inputs.set(event.toolCallId, '')
      } else if (event.type === 'tool_input_delta')
        inputs.set(event.toolCallId, (inputs.get(event.toolCallId) ?? '') + event.partialJson)
      else {
        if (event.stopReason === 'max_tokens') throw new Error('模型轮次截断')
        complete = true
      }
    }
    if (!complete) throw new Error('模型轮次未完成')
    for (const block of blocks)
      if (block.type === 'tool_use') block.input = JSON.parse(inputs.get(block.toolCallId) || '{}')
    if (text) blocks.unshift({ type: 'text', text: redactText(text) })
    return { blocks: redactDeep(blocks), text: redactText(text) }
  }

  /** 只读取白名单资源 金额或动作参数永远不能到达旧支付执行器 */
  private async read(
    name: string,
    args: Record<string, unknown>,
    customerId: string,
    knowledgeSnapshotId: string,
    orderSelectionEnabled: boolean,
    guidance = false,
  ): Promise<unknown> {
    if (name === 'list_my_orders' && orderSelectionEnabled) {
      const input = ListMyOrdersInput.parse(args)
      return new SqliteOrderRepository(this.db).listByCustomer(customerId, input.offset)
    }
    if (name === 'search_policy') {
      const input = ToolIO.search_policy.input.parse(args)
      const snapshot = buildKnowledgeSnapshot(new DeskRepository(this.db).policies())
      // 原版本不在当前库时明确失败 不将新语料静默当作旧运行的知识依据
      if (snapshot.snapshotId !== knowledgeSnapshotId) throw new Error('原知识快照不可用')
      return {
        articles: retrieveKnowledge(
          snapshot,
          input.query,
          'character-keyword-baseline',
          guidance ? 5 : 3,
        ),
      }
    }
    if (name !== 'get_order' && name !== 'get_shipment') throw new Error('工具不在只读白名单')
    const input = ToolIO[name].input.parse(args)
    const order = await new SqliteOrderRepository(this.db).findByOrderNo(input.orderNo)
    if (!order || order.customerId !== customerId) throw new Error('订单归属不匹配')
    return name === 'get_order'
      ? order
      : await new SqliteShipmentRepository(this.db).findByOrderNo(input.orderNo)
  }
}
