/**
 * Agent 运行循环 原生 tool calling 协议
 *
 * 模型每轮产出原生内容块 文本与工具参数增量先落事件再执行
 * 只读工具直接执行 业务动作经槽位校验后路由到确定性工作流
 * ask_user 是协议工具 把提问权交给模型 暂停等待用户回复
 * 模型永远触碰不到副作用工具 高风险动作由工作流与审批把关
 */

import {
  INTENT_SLOT_SCHEMAS,
  type Intent,
  type ToolErrorShape,
} from '@aftersales/contracts'
import { createToolError } from '@aftersales/contracts'
import { DomainError, redactText } from '@aftersales/domain'
import type {
  Actor,
  Clock,
  EventRepository,
  InjectLogisticsEventResult,
  RunService,
} from '@aftersales/domain'
import type { ToolExecutor } from '@aftersales/tools'
import { ToolExecutionError } from '@aftersales/tools'
import type { ToolContext } from '@aftersales/tools'
import type { WorkflowEngine, WorkflowResult } from '@aftersales/workflow'
import {
  type AssistantBlock,
  type ChatModel,
  type ModelMessage,
  type ToolDefinition,
} from './model.js'
import { buildSystemPrompt, PROMPT_VERSION } from './prompt.js'
import {
  ASK_USER_TOOL,
  CONCLUDE_TOOL,
  buildStepTools,
  isActionTool,
} from './tool-defs.js'
import { buildManagedContext } from './context.js'

/** 一轮处理的终态 */
export type RunOutcome =
  'completed' | 'awaiting_input' | 'awaiting_approval' | 'failed' | 'escalated'

export interface AgentRunnerDeps {
  model: ChatModel
  executor: ToolExecutor
  workflow: WorkflowEngine
  runs: RunService
  eventRepo: EventRepository
  clock: Clock
  /** 单轮处理内模型轮次上限 防无效循环 */
  maxSteps: number
  /** 上下文 token 预算估算值 超限触发压缩 缺省不压缩 */
  tokenBudget?: number
}

interface ModelTurn {
  blocks: AssistantBlock[]
  text: string
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
}

interface ToolResultEntry {
  toolCallId: string
  toolName: string
  content: string
  isError: boolean
}

export class AgentRunner {
  constructor(private readonly deps: AgentRunnerDeps) {}

  /** 首条消息启动运行 */
  async start(runId: string, userMessage: string, toolContext: ToolContext): Promise<RunOutcome> {
    const run = await this.deps.runs.get(runId)
    await this.deps.runs.transition(runId, 'running')
    await this.deps.runs.emit(runId, 'run.started', {
      customerId: run.customerId,
      promptVersion: PROMPT_VERSION,
      model: this.deps.model.info.model,
    })
    await this.deps.runs.emit(runId, 'message.user', { text: redactText(userMessage) })
    return this.processLoop(runId, run.customerId, toolContext)
  }

  /** 补问答复继续运行 回复绑定到挂起的 ask_user 调用构成 tool_result */
  async continueWithMessage(
    runId: string,
    userMessage: string,
    toolContext: ToolContext,
  ): Promise<RunOutcome> {
    const run = await this.deps.runs.get(runId)
    if (run.status !== 'awaiting_input') {
      throw new DomainError(
        createToolError('CONFLICT', `运行状态 ${run.status} 不在接受补问 请先恢复或查看详情`),
      )
    }
    const pendingAsk = await this.findPendingToolCall(runId, ASK_USER_TOOL)
    await this.deps.runs.transition(runId, 'running')
    await this.deps.runs.emit(runId, 'run.resumed', { resumePoint: 'user_message' })
    await this.deps.runs.emit(runId, 'message.user', {
      text: redactText(userMessage),
      replyToToolCallId: pendingAsk?.toolCallId,
    })
    return this.processLoop(runId, run.customerId, toolContext)
  }

  /**
   * 物流事件注入
   *
   * 混合到达语义 事件先落表 无论会话状态 时间线始终可回放
   * 会话空闲等待输入时事件即达即触达 驱动一轮主动告知客户的回合
   * 其余状态仅落表挂起 下一轮对话重建上下文时自然带出
   */
  async processLogisticsEvent(
    runId: string,
    event: InjectLogisticsEventResult,
    toolContext: ToolContext,
  ): Promise<{ delivered: boolean; outcome?: RunOutcome }> {
    const run = await this.deps.runs.get(runId)
    await this.deps.eventRepo.append(runId, 'logistics.event', {
      orderNo: event.orderNo,
      carrier: event.carrier,
      trackingNo: event.trackingNo,
      status: event.status,
      description: event.description,
      eventId: event.eventId,
      source: event.source,
      injectedAt: event.injectedAt,
    })
    if (run.status !== 'awaiting_input') {
      return { delivered: false }
    }
    await this.deps.runs.transition(runId, 'running')
    await this.deps.runs.emit(runId, 'run.resumed', { resumePoint: 'logistics_event' })
    const outcome = await this.processLoop(runId, run.customerId, toolContext)
    return { delivered: true, outcome }
  }

  /** 审批决定后恢复 工作流结果回灌为动作工具的 tool_result 再继续生成答复 */
  async resumeAfterApproval(
    runId: string,
    approvalId: string,
    decision: 'approved' | 'rejected' | 'expired',
    decidedBy: string,
    toolContext: ToolContext,
  ): Promise<RunOutcome> {
    const run = await this.deps.runs.get(runId)
    if (run.status !== 'awaiting_approval') {
      throw new DomainError(createToolError('CONFLICT', `运行状态 ${run.status} 不在等待审批`))
    }
    const result = await this.deps.workflow.resumeAfterApproval(
      runId,
      approvalId,
      decision,
      decidedBy,
      toolContext,
    )
    const outcome = await this.handleWorkflowResult(runId, result)
    if (outcome === 'continue') {
      return this.processLoop(runId, run.customerId, toolContext)
    }
    return outcome
  }

  /**
   * 断点恢复 续跑未完成的工作流步骤后继续生成答复
   *
   * 模型调用无状态可重放 进程中断卡在 running 且无工作流断点的运行
   * 直接从事件重建上下文续跑 上下文已落的步骤不会重复执行
   */
  async resumeFromCheckpoint(runId: string, toolContext: ToolContext): Promise<RunOutcome> {
    const run = await this.deps.runs.get(runId)
    let outcome: RunOutcome | 'continue'
    try {
      const result = await this.deps.workflow.resumeFromCheckpoint(runId, toolContext)
      outcome = await this.handleWorkflowResult(runId, result)
    } catch (error) {
      // 无工作流断点 属于模型调用阶段中断 直接续跑循环
      if (
        error instanceof DomainError &&
        (error as DomainError & { shape?: { code?: string } }).shape?.code === 'NOT_FOUND'
      ) {
        outcome = 'continue'
      } else {
        throw error
      }
    }
    if (outcome === 'continue') {
      // 崩溃恢复的运行本就停在 running 无需迁移 中断于其他状态才回到运行态
      if (run.status !== 'running') {
        await this.deps.runs.transition(runId, 'running')
        await this.deps.runs.emit(runId, 'run.resumed', { resumePoint: 'checkpoint' })
      }
      return this.processLoop(runId, run.customerId, toolContext)
    }
    return outcome
  }

  /**
   * 主循环
   *
   * 每轮先重建上下文再调用模型 工具参数边流边落事件
   * 副作用动作暂停于审批或失败 结果以 tool_result 回灌模型收敛
   */
  private async processLoop(
    runId: string,
    customerId: string,
    toolContext: ToolContext,
  ): Promise<RunOutcome> {
    for (let step = 1; step <= this.deps.maxSteps; step++) {
      const context = await buildManagedContext({
        eventRepo: this.deps.eventRepo,
        runId,
        tokenBudget: this.deps.tokenBudget,
      })
      const system = buildSystemPrompt({
        currentTime: this.deps.clock.now().toISOString(),
        customerId,
        workingMemory: context.workingMemory,
      })
      const tools = await this.prepareStepTools(runId)

      const turn = await this.runModelTurn(runId, system, context.messages, tools)
      await this.deps.eventRepo.append(runId, 'agent.turn', {
        blocks: turn.blocks,
        stopReason: turn.stopReason,
      })

      if (turn.stopReason === 'max_tokens') {
        return this.failRun(runId, 'VALIDATION_ERROR', '模型输出因长度上限被截断')
      }
      if (turn.text) {
        await this.emitMessageCompleted(runId, turn.text)
      }

      const toolBlocks = turn.blocks.filter(
        (block): block is Extract<AssistantBlock, { type: 'tool_use' }> => block.type === 'tool_use',
      )

      // 纯文本轮即等待用户回复 模型完成任务须显式调用 conclude
      if (toolBlocks.length === 0) {
        if (turn.stopReason === 'end_turn') {
          if (!turn.text.trim()) {
            return this.failRun(runId, 'VALIDATION_ERROR', '模型轮次未产出任何内容')
          }
          await this.deps.runs.transition(runId, 'awaiting_input')
          await this.deps.runs.emit(runId, 'run.paused', {
            reason: 'awaiting_input',
            hint: redactText(turn.text).slice(0, 120),
          })
          return 'awaiting_input'
        }
        return this.failRun(runId, 'VALIDATION_ERROR', '模型轮次无可执行的输出')
      }

      // 工具轮 按序执行每个工具块
      for (const block of toolBlocks) {
        if (block.toolName === ASK_USER_TOOL) {
          await this.handleAskUser(runId, block)
          return 'awaiting_input'
        }
        if (block.toolName === CONCLUDE_TOOL) {
          const answer = redactText(turn.text || '任务已完成')
          const summary =
            typeof block.input.summary === 'string' && block.input.summary.trim()
              ? redactText(block.input.summary)
              : answer.slice(0, 120)
          await this.deps.runs.transition(runId, 'completed')
          await this.deps.runs.emit(runId, 'run.completed', {
            summary,
            escalated: false,
          })
          return 'completed'
        }
        if (isActionTool(block.toolName)) {
          const outcome = await this.handleActionTool(runId, block, toolContext)
          if (outcome !== 'continue') {
            return outcome
          }
          continue
        }
        const outcome = await this.executeReadTool(runId, block, toolContext)
        if (outcome !== 'continue') {
          return outcome
        }
      }
    }

    return this.failRun(runId, 'INTERNAL_ERROR', '达到单轮最大步骤数')
  }

  /** 消费模型流 累积文本与工具块 增量事件先落库 */
  private async runModelTurn(
    runId: string,
    system: string,
    messages: ModelMessage[],
    tools: ToolDefinition[],
  ): Promise<ModelTurn> {
    const toolBlocks: AssistantBlock[] = []
    const toolJson = new Map<string, string>()
    let text = ''
    let stopReason: ModelTurn['stopReason'] = 'end_turn'

    for await (const event of this.deps.model.stream({ system, messages, tools })) {
      if (event.type === 'text_delta') {
        text += event.text
        // 逐段脱敏 完整文本以 message.completed 为准 跨段边界的敏感串以完成事件覆盖
        await this.deps.eventRepo.append(runId, 'message.delta', {
          textDelta: redactText(event.text),
        })
      } else if (event.type === 'tool_call_start') {
        toolBlocks.push({
          type: 'tool_use',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: {},
        })
        toolJson.set(event.toolCallId, '')
      } else if (event.type === 'tool_input_delta') {
        toolJson.set(
          event.toolCallId,
          (toolJson.get(event.toolCallId) ?? '') + event.partialJson,
        )
        const block = toolBlocks.find(
          (candidate) =>
            candidate.type === 'tool_use' && candidate.toolCallId === event.toolCallId,
        )
        await this.deps.eventRepo.append(runId, 'tool.input.delta', {
          toolCallId: event.toolCallId,
          toolName: block?.type === 'tool_use' ? block.toolName : '',
          partialJson: event.partialJson,
        })
      } else {
        stopReason = event.stopReason
        break
      }
    }

    // 累积的工具参数 JSON 解析为输入 解析失败以原始串落块 由执行层反馈错误
    for (const block of toolBlocks) {
      if (block.type !== 'tool_use') continue
      const raw = toolJson.get(block.toolCallId) ?? ''
      try {
        block.input = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        block.input = { __raw: raw }
      }
    }

    const blocks: AssistantBlock[] = text
      ? [{ type: 'text', text }, ...toolBlocks]
      : toolBlocks
    return { blocks, text, stopReason }
  }

  /** 每步工具目录 能力门控 未查过订单时动作工具不进目录 结构性防盲提交 */
  private async prepareStepTools(runId: string): Promise<ToolDefinition[]> {
    const events = await this.deps.eventRepo.listByRun(runId)
    const orderLoaded = events.some(
      (event) =>
        event.type === 'tool.completed' &&
        (event.payload as { toolName?: string }).toolName === 'get_order' &&
        (event.payload as { status?: string }).status === 'succeeded',
    )
    return buildStepTools({ actionsAvailable: orderLoaded })
  }

  /** ask_user 提问落为助手消息并暂停 */
  private async handleAskUser(
    runId: string,
    block: Extract<AssistantBlock, { type: 'tool_use' }>,
  ): Promise<void> {
    const question =
      typeof block.input.question === 'string' && block.input.question.trim()
        ? redactText(block.input.question)
        : '请问还有什么可以帮您'
    await this.emitMessageCompleted(runId, question)
    await this.deps.runs.transition(runId, 'awaiting_input')
    await this.deps.runs.emit(runId, 'run.paused', {
      reason: 'awaiting_input',
      hint: question,
    })
  }

  /** 只读工具执行 成败都以 tool_result 回灌模型 失败供其重规划 */
  private async executeReadTool(
    runId: string,
    block: Extract<AssistantBlock, { type: 'tool_use' }>,
    toolContext: ToolContext,
  ): Promise<RunOutcome | 'continue'> {
    let result: ToolResultEntry
    if ('__raw' in block.input) {
      result = {
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        content: '工具参数 JSON 解析失败 请重新发起调用',
        isError: true,
      }
    } else {
      try {
        const output = await this.deps.executor.execute(block.toolName, block.input, toolContext)
        result = {
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          content: JSON.stringify(output),
          isError: false,
        }
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          result = {
            toolCallId: block.toolCallId,
            toolName: block.toolName,
            content: JSON.stringify({ code: error.code, message: error.message }),
            isError: true,
          }
        } else {
          throw error
        }
      }
    }
    await this.appendToolResults(runId, [result])
    return 'continue'
  }

  /** 业务动作工具 槽位校验后交给确定性工作流 */
  private async handleActionTool(
    runId: string,
    block: Extract<AssistantBlock, { type: 'tool_use' }>,
    toolContext: ToolContext,
  ): Promise<RunOutcome | 'continue'> {
    const intent = block.toolName as Intent
    const slotSchema = INTENT_SLOT_SCHEMAS[intent]
    if (!slotSchema) {
      await this.appendToolResults(runId, [
        {
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          content: `未知业务动作 ${block.toolName}`,
          isError: true,
        },
      ])
      return 'continue'
    }
    const parsedSlots = slotSchema.safeParse(block.input)
    if (!parsedSlots.success) {
      await this.appendToolResults(runId, [
        {
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          content: `槽位校验失败 ${parsedSlots.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
          isError: true,
        },
      ])
      return 'continue'
    }

    await this.deps.runs.setIntent(runId, intent)

    const result = await this.deps.workflow.start(
      runId,
      intent,
      parsedSlots.data,
      toolContext,
    )
    return this.handleWorkflowResultForTool(runId, block.toolCallId, block.toolName, result)
  }

  /** 工作流结果路由 暂停等审批 完成或失败都以 tool_result 回灌后继续循环 */
  private async handleWorkflowResultForTool(
    runId: string,
    toolCallId: string,
    toolName: string,
    result: WorkflowResult,
  ): Promise<RunOutcome | 'continue'> {
    if (result.status === 'paused') {
      await this.deps.runs.emit(runId, 'run.paused', { reason: 'awaiting_approval' })
      return 'awaiting_approval'
    }
    if (result.status === 'failed') {
      await this.appendToolResults(runId, [
        {
          toolCallId,
          toolName,
          content: JSON.stringify({ error: result.error }),
          isError: true,
        },
      ])
      return 'continue'
    }

    if (toolName === 'escalate') {
      await this.emitMessageCompleted(runId, '已为您升级人工客服 请稍候')
      await this.deps.runs.transition(runId, 'escalated')
      await this.deps.runs.emit(runId, 'run.escalated', { reason: '模型主动升级' })
      return 'escalated'
    }
    await this.appendToolResults(runId, [
      { toolCallId, toolName, content: JSON.stringify({ summary: result.summary }), isError: false },
    ])
    return 'continue'
  }

  /** 审批与断点恢复后的工作流结果 绑定到挂起的动作调用 */
  private async handleWorkflowResult(
    runId: string,
    result: WorkflowResult,
  ): Promise<RunOutcome | 'continue'> {
    if (result.status === 'paused') {
      await this.deps.runs.emit(runId, 'run.paused', { reason: 'awaiting_approval' })
      return 'awaiting_approval'
    }
    const pending = await this.findPendingActionCall(runId)
    if (result.status === 'failed') {
      if (pending) {
        await this.appendToolResults(runId, [
          {
            toolCallId: pending.toolCallId,
            toolName: pending.toolName,
            content: JSON.stringify({ error: result.error }),
            isError: true,
          },
        ])
      }
      return 'continue'
    }
    if (pending) {
      await this.appendToolResults(runId, [
        {
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
          content: JSON.stringify({ summary: result.summary }),
          isError: false,
        },
      ])
    }
    return 'continue'
  }

  /** 查找未回灌的指定名称工具调用 供补问绑定与恢复回灌 */
  private async findPendingToolCall(
    runId: string,
    toolName: string,
  ): Promise<{ toolCallId: string; toolName: string } | null> {
    const events = await this.deps.eventRepo.listByRun(runId)
    const answered = new Set<string>()
    const calls: Array<{ toolCallId: string; toolName: string }> = []
    for (const event of events) {
      if (event.type === 'agent.turn') {
        const payload = event.payload as { blocks: Array<Record<string, unknown>> }
        for (const raw of payload.blocks) {
          if (raw.type === 'tool_use') {
            calls.push({ toolCallId: String(raw.toolCallId), toolName: String(raw.toolName) })
          }
        }
      } else if (event.type === 'agent.tool_results') {
        const payload = event.payload as { results: Array<{ toolCallId: string }> }
        for (const result of payload.results) {
          answered.add(result.toolCallId)
        }
      } else if (event.type === 'message.user') {
        const reply = (event.payload as { replyToToolCallId?: string }).replyToToolCallId
        if (reply) answered.add(reply)
      }
    }
    const candidates = calls.filter(
      (call) => call.toolName === toolName && !answered.has(call.toolCallId),
    )
    return candidates[candidates.length - 1] ?? null
  }

  private async findPendingActionCall(runId: string): Promise<{
    toolCallId: string
    toolName: string
  } | null> {
    const events = await this.deps.eventRepo.listByRun(runId)
    const answered = new Set<string>()
    const calls: Array<{ toolCallId: string; toolName: string }> = []
    for (const event of events) {
      if (event.type === 'agent.turn') {
        const payload = event.payload as { blocks: Array<Record<string, unknown>> }
        for (const raw of payload.blocks) {
          if (raw.type === 'tool_use' && isActionTool(String(raw.toolName))) {
            calls.push({ toolCallId: String(raw.toolCallId), toolName: String(raw.toolName) })
          }
        }
      } else if (event.type === 'agent.tool_results') {
        const payload = event.payload as { results: Array<{ toolCallId: string }> }
        for (const result of payload.results) {
          answered.add(result.toolCallId)
        }
      }
    }
    const candidates = calls.filter((call) => !answered.has(call.toolCallId))
    return candidates[candidates.length - 1] ?? null
  }

  private async appendToolResults(runId: string, results: ToolResultEntry[]): Promise<void> {
    await this.deps.eventRepo.append(runId, 'agent.tool_results', { results })
  }

  private async emitMessageCompleted(runId: string, text: string): Promise<void> {
    await this.deps.eventRepo.append(runId, 'message.completed', {
      role: 'assistant',
      text: redactText(text),
    })
  }

  private async failRun(runId: string, code: string, message: string): Promise<'failed'> {
    await this.deps.runs.transition(runId, 'failed', { error: message })
    await this.deps.runs.emit(runId, 'run.failed', { errorCode: code, message })
    return 'failed'
  }
}

/** 从错误形状提取可读信息 供 API 错误响应复用 */
export function describeToolError(error: ToolErrorShape): string {
  return `[${error.code}] ${error.message}`
}

/** 构建工具上下文的便捷工厂 */
export function toolContextFor(
  actor: Actor,
  runId: string | null,
  faults: ToolContext['faults'],
): ToolContext {
  return { actor, runId, faults }
}
