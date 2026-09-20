/**
 * Agent 运行循环
 *
 * 模型负责理解 澄清与发起动作 运行时负责校验 执行与留痕
 * 循环的每一步都先落事件 再产生副作用 恢复时从事件重建上下文
 * 模型永远触碰不到副作用工具 高风险动作由工作流与审批把关
 */

import {
  AgentOutput,
  INTENT_SLOT_SCHEMAS,
  type Intent,
  type ToolErrorShape,
} from '@aftersales/contracts'
import { createToolError } from '@aftersales/contracts'
import { DomainError, redactText } from '@aftersales/domain'
import type { Actor, Clock, EventRepository, RunService } from '@aftersales/domain'
import type { ToolExecutor } from '@aftersales/tools'
import { ToolExecutionError } from '@aftersales/tools'
import type { ToolContext } from '@aftersales/tools'
import type { WorkflowEngine, WorkflowResult } from '@aftersales/workflow'
import { type ChatModel, type ModelMessage } from './model.js'
import { buildSystemPrompt, PROMPT_VERSION } from './prompt.js'

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
  /** 单轮处理内模型调用上限 防无效循环 */
  maxSteps: number
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

  /** 补问答复继续运行 */
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
    await this.deps.runs.transition(runId, 'running')
    await this.deps.runs.emit(runId, 'run.resumed', { resumePoint: 'user_message' })
    await this.deps.runs.emit(runId, 'message.user', { text: redactText(userMessage) })
    return this.processLoop(runId, run.customerId, toolContext)
  }

  /** 审批决定后恢复 生成最终答复 */
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
    const outcome = await this.handleWorkflowResult(runId, run.customerId, result)
    if (outcome === 'continue') {
      return this.processLoop(runId, run.customerId, toolContext)
    }
    return outcome
  }

  /** 断点恢复 续跑未完成的工作流步骤后继续生成答复 */
  async resumeFromCheckpoint(runId: string, toolContext: ToolContext): Promise<RunOutcome> {
    const run = await this.deps.runs.get(runId)
    const result = await this.deps.workflow.resumeFromCheckpoint(runId, toolContext)
    const outcome = await this.handleWorkflowResult(runId, run.customerId, result)
    if (outcome === 'continue') {
      return this.processLoop(runId, run.customerId, toolContext)
    }
    return outcome
  }

  /**
   * 主循环
   *
   * 每次迭代先重建上下文再调用模型 输出经 Zod 校验
   * 非法输出走一轮修复 重试仍失败则运行失败
   */
  private async processLoop(
    runId: string,
    customerId: string,
    toolContext: ToolContext,
  ): Promise<RunOutcome> {
    for (let step = 1; step <= this.deps.maxSteps; step++) {
      const messages = await this.rebuildContext(runId)
      const system = buildSystemPrompt({
        currentTime: this.deps.clock.now().toISOString(),
        customerId,
      })

      const output = await this.callModelWithRepair(runId, system, messages)
      if (!output) {
        await this.deps.runs.transition(runId, 'failed', { error: '模型输出无法解析为合法结构' })
        await this.deps.runs.emit(runId, 'run.failed', {
          errorCode: 'VALIDATION_ERROR',
          message: '模型输出无法解析为合法结构',
        })
        return 'failed'
      }
      await this.deps.runs.emit(runId, 'agent.output', {
        output: output as unknown as Record<string, unknown>,
      })

      switch (output.kind) {
        case 'tool_call': {
          const outcome = await this.executeReadTool(runId, output, toolContext)
          if (outcome === 'continue') continue
          return outcome
        }
        case 'clarify': {
          await this.emitAssistantMessage(runId, output.question)
          await this.deps.runs.transition(runId, 'awaiting_input')
          await this.deps.runs.emit(runId, 'run.paused', {
            reason: 'awaiting_input',
            hint: output.question,
          })
          return 'awaiting_input'
        }
        case 'action': {
          const outcome = await this.handleAction(runId, output, toolContext)
          if (outcome === 'continue') continue
          return outcome
        }
        case 'final': {
          const answer = redactText(output.answer)
          await this.emitAssistantMessage(runId, answer)
          await this.deps.runs.transition(runId, 'completed')
          await this.deps.runs.emit(runId, 'run.completed', {
            summary: output.summary || answer.slice(0, 120),
            escalated: output.escalated,
          })
          return 'completed'
        }
        case 'escalate': {
          const result = await this.deps.workflow.start(
            runId,
            'escalate',
            { reason: output.reason },
            toolContext,
          )
          if (result.status === 'failed') {
            await this.deps.runs.transition(runId, 'failed', { error: result.error.message })
            await this.deps.runs.emit(runId, 'run.failed', {
              errorCode: result.error.code,
              message: result.error.message,
            })
            return 'failed'
          }
          await this.emitAssistantMessage(runId, `已为您升级人工客服 原因 ${output.reason} 请稍候`)
          await this.deps.runs.transition(runId, 'escalated')
          await this.deps.runs.emit(runId, 'run.escalated', { reason: output.reason })
          return 'escalated'
        }
      }
    }

    await this.deps.runs.transition(runId, 'failed', { error: '达到单轮最大步骤数' })
    await this.deps.runs.emit(runId, 'run.failed', {
      errorCode: 'INTERNAL_ERROR',
      message: '达到单轮最大步骤数',
    })
    return 'failed'
  }

  /** 只读工具执行 失败结果也回给模型供其重规划 */
  private async executeReadTool(
    runId: string,
    output: Extract<AgentOutput, { kind: 'tool_call' }>,
    toolContext: ToolContext,
  ): Promise<RunOutcome | 'continue'> {
    try {
      await this.deps.executor.execute(output.tool, output.args, toolContext)
      return 'continue'
    } catch (error) {
      if (error instanceof ToolExecutionError) {
        await this.deps.eventRepo.append(runId, 'agent.output', {
          output: {
            kind: 'tool_error_feedback',
            tool: error.toolName,
            code: error.code,
            message: error.message,
          },
        })
        return 'continue'
      }
      throw error
    }
  }

  /** 业务动作 槽位校验后交给确定性工作流 */
  private async handleAction(
    runId: string,
    output: Extract<AgentOutput, { kind: 'action' }>,
    toolContext: ToolContext,
  ): Promise<RunOutcome | 'continue'> {
    const slotSchema = INTENT_SLOT_SCHEMAS[output.intent as Intent]
    if (!slotSchema) {
      await this.deps.eventRepo.append(runId, 'agent.output', {
        output: { kind: 'action_rejected', reason: `未知意图 ${output.intent}` },
      })
      return 'continue'
    }
    const parsedSlots = slotSchema.safeParse(output.slots)
    if (!parsedSlots.success) {
      await this.deps.eventRepo.append(runId, 'agent.output', {
        output: {
          kind: 'action_rejected',
          reason: `槽位校验失败 ${parsedSlots.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
        },
      })
      return 'continue'
    }

    await this.deps.runs.setIntent(runId, output.intent)
    const run = await this.deps.runs.get(runId)

    const result = await this.deps.workflow.start(
      runId,
      output.intent as Intent,
      parsedSlots.data,
      toolContext,
    )
    const outcome = await this.handleWorkflowResult(runId, run.customerId, result)
    if (outcome === 'continue') {
      return 'continue'
    }
    return outcome
  }

  /** 工作流结果路由 暂停等审批 完成或失败都回给模型继续循环 由调用方决定走向 */
  private async handleWorkflowResult(
    runId: string,
    customerId: string,
    result: WorkflowResult,
  ): Promise<RunOutcome | 'continue'> {
    if (result.status === 'paused') {
      await this.deps.runs.emit(runId, 'run.paused', { reason: 'awaiting_approval' })
      return 'awaiting_approval'
    }
    if (result.status === 'failed') {
      await this.deps.eventRepo.append(runId, 'agent.output', {
        output: {
          kind: 'workflow_error_feedback',
          error: result.error as unknown as Record<string, unknown>,
        },
      })
      return 'continue'
    }
    // 完成的动作回给模型生成用户答复
    await this.deps.eventRepo.append(runId, 'agent.output', {
      output: { kind: 'workflow_completed', summary: result.summary },
    })
    return 'continue'
  }

  /**
   * 从事件重建模型上下文
   *
   * 事件是唯一事实来源 刷新与恢复后不依赖任何内存状态
   */
  private async rebuildContext(runId: string): Promise<ModelMessage[]> {
    const events = await this.deps.eventRepo.listByRun(runId)
    const messages: ModelMessage[] = []
    for (const event of events) {
      if (event.type === 'message.user') {
        const payload = event.payload as { text: string }
        messages.push({ role: 'user', content: payload.text })
      } else if (event.type === 'agent.output') {
        const payload = event.payload as { output: Record<string, unknown> }
        if (
          payload.output.kind === 'tool_error_feedback' ||
          payload.output.kind === 'workflow_error_feedback'
        ) {
          messages.push({
            role: 'tool_result',
            toolName: 'system',
            content: JSON.stringify(payload.output),
          })
        } else if (payload.output.kind === 'workflow_completed') {
          messages.push({
            role: 'tool_result',
            toolName: 'workflow',
            content: JSON.stringify(payload.output),
          })
        } else {
          messages.push({ role: 'assistant', content: JSON.stringify(payload.output) })
        }
      } else if (event.type === 'tool.completed') {
        const payload = event.payload as {
          toolName: string
          status: string
          resultSummary?: Record<string, unknown>
          errorCode?: string
        }
        messages.push({
          role: 'tool_result',
          toolName: payload.toolName,
          content: JSON.stringify({
            status: payload.status,
            result: payload.resultSummary,
            errorCode: payload.errorCode,
          }),
        })
      }
    }
    return messages
  }

  /** 模型调用 非法输出追加错误反馈重试一次 */
  private async callModelWithRepair(
    runId: string,
    system: string,
    messages: ModelMessage[],
  ): Promise<AgentOutput | null> {
    const first = await this.callModel(system, messages)
    const parsedFirst = this.parseOutput(first)
    if (parsedFirst) {
      return parsedFirst
    }
    const repaired = await this.callModel(system, [
      ...messages,
      { role: 'assistant', content: first },
      {
        role: 'tool_result',
        toolName: 'system',
        content: '上一次输出不是合法的结构化 JSON 请严格按照输出契约重新输出 不要包含任何其他文本',
      },
    ])
    return this.parseOutput(repaired)
  }

  /** 从原始文本提取并校验结构化输出 兼容被代码围栏包裹的情况 */
  private parseOutput(raw: string): AgentOutput | null {
    const trimmed = raw.trim()
    const candidates = [trimmed]
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch?.[1]) {
      candidates.unshift(fenceMatch[1].trim())
    }
    const firstBrace = trimmed.indexOf('{')
    const lastBrace = trimmed.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
    }
    for (const candidate of candidates) {
      try {
        const obj = JSON.parse(candidate) as unknown
        const parsed = AgentOutput.safeParse(obj)
        if (parsed.success) {
          return parsed.data
        }
      } catch {
        // 尝试下一个候选
      }
    }
    return null
  }

  private async callModel(system: string, messages: ModelMessage[]): Promise<string> {
    const result = await this.deps.model.complete({ system, messages })
    return result.raw
  }

  /** 助手消息落事件 分片 delta 加完整 completed 便于流式渲染与重放 */
  private async emitAssistantMessage(runId: string, text: string): Promise<void> {
    const mid = Math.ceil(text.length / 2)
    const chunks = text.length > 2 ? [text.slice(0, mid), text.slice(mid)] : [text]
    for (const chunk of chunks) {
      await this.deps.runs.emit(runId, 'message.delta', { textDelta: chunk })
    }
    await this.deps.runs.emit(runId, 'message.completed', { role: 'assistant', text })
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
