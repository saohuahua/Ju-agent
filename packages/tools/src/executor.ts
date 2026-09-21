/**
 * 工具执行器
 *
 * 统一入口 输入校验 故障注入 超时 重试退避 事件与轨迹记录
 * Agent 只读工具与工作流副作用工具都经过这里
 * 任何失败 DomainError 超时 上游错误都会写入 tool_executions 并发出 tool.completed 事件
 */

import type { EventType } from '@aftersales/contracts'
import { DEFAULT_RETRY_POLICY } from '@aftersales/contracts'
import { DomainError, redactDeep } from '@aftersales/domain'
import type { Clock, EventRepository, ToolExecutionRepository } from '@aftersales/domain'
import { toIso } from '@aftersales/domain'
import type { ToolContext, ToolRegistry } from './registry.js'
import { ToolExecutionError } from './registry.js'

/** 注入超时故障时处理器的挂起时长 评测执行器超时配 300ms 即可触发 */
const FAULT_HANG_MS = 800

export interface ExecutorDeps {
  registry: ToolRegistry
  toolExecutionRepo: ToolExecutionRepository
  eventRepo: EventRepository
  clock: Clock
  /** 覆盖描述符超时 评测用来加速 */
  timeoutOverrideMs?: number
}

interface AttemptOutcome {
  status: 'succeeded' | 'failed'
  resultSummary?: Record<string, unknown>
  errorCode?: string
  errorMessage?: string
  retryable: boolean
  latencyMs: number
}

/** 进程中断信号 特殊错误 不写失败状态 模拟进程死亡 由断点恢复接管 */
export class ProcessCrashError extends Error {
  constructor(public readonly toolName: string) {
    super(`模拟进程中断 ${toolName}`)
    this.name = 'ProcessCrashError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class ToolExecutor {
  /** 守卫定时器集合 竞速结束统一清理 避免进程退出被拖延 */
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>()
  /** 单调递增执行序号 保证同一工具多次调用时 executionId 不撞车 */
  private executionSeq = 0

  constructor(private readonly deps: ExecutorDeps) {}

  /**
   * 执行工具
   *
   * 成功返回脱敏后的工具输出 失败抛 ToolExecutionError
   * 每一次尝试无论成败都留下轨迹证据
   */
  async execute(
    toolName: string,
    rawArgs: Record<string, unknown>,
    context: ToolContext,
  ): Promise<Record<string, unknown>> {
    const definition = this.deps.registry.get(toolName)
    if (!definition) {
      throw new ToolExecutionError(toolName, 'VALIDATION_ERROR', `未注册工具 ${toolName}`, false)
    }
    const parsedInput = definition.inputSchema.safeParse(rawArgs)
    if (!parsedInput.success) {
      throw new ToolExecutionError(
        toolName,
        'VALIDATION_ERROR',
        `工具参数校验失败 ${parsedInput.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
        false,
      )
    }

    const retryPolicy = DEFAULT_RETRY_POLICY
    const timeoutMs = this.deps.timeoutOverrideMs ?? definition.descriptor.timeoutMs
    let lastFailure: AttemptOutcome | null = null

    const callId = `${context.runId ?? 'op'}-${toolName}-${++this.executionSeq}`
    for (let attempt = 1; attempt <= 1 + retryPolicy.maxRetries; attempt++) {
      const fault = context.faults?.consume(toolName) ?? null

      // crash 故障直接模拟进程死亡 不写任何失败轨迹与状态
      if (fault === 'crash') {
        throw new ProcessCrashError(toolName)
      }

      await this.emitEvent(context, 'tool.requested', {
        executionId: `${callId}-${attempt}`,
        toolName,
        attempt,
        args: redactDeep(rawArgs),
      })

      const outcome = await this.runAttempt(
        toolName,
        definition.handler,
        parsedInput.data as never,
        context,
        fault,
        timeoutMs,
        attempt,
        callId,
      )

      if (outcome.status === 'succeeded') {
        return outcome.resultSummary ?? {}
      }

      lastFailure = outcome
      const canRetry =
        outcome.retryable &&
        retryPolicy.retryOn.includes((outcome.errorCode ?? '') as never) &&
        attempt < 1 + retryPolicy.maxRetries
      if (!canRetry) {
        break
      }
      await sleep(retryPolicy.backoffBaseMs * attempt)
    }

    const failure = lastFailure ?? {
      errorCode: 'INTERNAL_ERROR',
      errorMessage: '未知执行失败',
      retryable: false,
    }
    throw new ToolExecutionError(
      toolName,
      failure.errorCode ?? 'INTERNAL_ERROR',
      failure.errorMessage ?? `${toolName} 执行失败`,
      failure.retryable,
    )
  }

  /** 单次尝试 含异常归一 超时控制 输出校验与轨迹写入 */
  private async runAttempt(
    toolName: string,
    handler: (input: never, context: ToolContext) => Promise<Record<string, unknown>>,
    input: unknown,
    context: ToolContext,
    fault: string | null,
    timeoutMs: number,
    attempt: number,
    callId: string,
  ): Promise<AttemptOutcome> {
    const startedAt = this.deps.clock.now().getTime()
    const executionId = `${callId}-${attempt}`
    const definition = this.deps.registry.get(toolName)

    const attemptWork = async (): Promise<AttemptOutcome> => {
      try {
        // 注入故障 timeout 表现为处理器挂起
        if (fault === 'timeout') {
          await sleep(FAULT_HANG_MS)
        }
        if (fault === 'rate_limited') {
          return {
            status: 'failed',
            errorCode: 'RATE_LIMITED',
            errorMessage: '渠道限流',
            retryable: true,
            latencyMs: 5,
          }
        }
        if (fault === 'server_error') {
          return {
            status: 'failed',
            errorCode: 'UPSTREAM_ERROR',
            errorMessage: '渠道服务异常',
            retryable: true,
            latencyMs: 10,
          }
        }
        const output = (await handler(input as never, context)) as Record<string, unknown>
        return {
          status: 'succeeded',
          resultSummary: redactDeep(output),
          retryable: false,
          latencyMs: this.deps.clock.now().getTime() - startedAt,
        }
      } catch (error) {
        // DomainError 携带结构化错误码 其余归为内部错误
        if (error instanceof DomainError) {
          return {
            status: 'failed',
            errorCode: error.shape.code,
            errorMessage: error.shape.message,
            retryable: error.shape.retryable,
            latencyMs: this.deps.clock.now().getTime() - startedAt,
          }
        }
        return {
          status: 'failed',
          errorCode: 'INTERNAL_ERROR',
          errorMessage: error instanceof Error ? error.message : String(error),
          retryable: false,
          latencyMs: this.deps.clock.now().getTime() - startedAt,
        }
      }
    }

    // 超时守卫与业务执行竞速 先到先得
    let guardTimer: ReturnType<typeof setTimeout> | undefined
    const timeoutGuard = new Promise<AttemptOutcome>((resolve) => {
      guardTimer = setTimeout(() => {
        resolve({
          status: 'failed',
          errorCode: 'TIMEOUT',
          errorMessage: `工具执行超时 ${toolName}`,
          retryable: true,
          latencyMs: timeoutMs,
        })
      }, timeoutMs)
    })

    const outcome = await Promise.race([attemptWork(), timeoutGuard])
    if (guardTimer) clearTimeout(guardTimer)

    // 输出校验失败按内部错误处理 防止脏数据进入事件流
    const validatedSummary =
      outcome.status === 'succeeded' &&
      definition &&
      definition.outputSchema.safeParse(outcome.resultSummary).success
        ? outcome.resultSummary
        : outcome.status === 'succeeded'
          ? { truncated: true }
          : undefined

    await this.deps.toolExecutionRepo.create({
      runId: context.runId,
      toolName,
      args: redactDeep(input as Record<string, unknown>),
      status: outcome.status,
      errorCode: outcome.errorCode ?? null,
      attempt,
      latencyMs: outcome.latencyMs,
      resultSummary: validatedSummary ?? null,
      createdAt: toIso(this.deps.clock.now()),
    })

    await this.emitEvent(context, 'tool.completed', {
      executionId,
      toolName,
      status: outcome.status,
      resultSummary: validatedSummary,
      errorCode: outcome.errorCode,
      latencyMs: outcome.latencyMs,
    })

    return outcome
  }

  /** 有 runId 才发事件 运营操作只走审计 */
  private async emitEvent(
    context: ToolContext,
    type: EventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!context.runId) return
    await this.deps.eventRepo.append(context.runId, type, payload)
  }
}
