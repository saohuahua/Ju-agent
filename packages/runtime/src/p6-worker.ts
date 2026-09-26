import type { SqliteDatabase } from '../../persistence/src/db.js'
import { P6OwnershipLost } from '../../persistence/src/p6-task-repository.js'
import type { P6TaskRepository } from '../../persistence/src/p6-task-repository.js'
import type {
  P6ConfigSnapshot,
  P6Limits,
  P6Payment,
  P6PaymentPort,
  P6PaymentResult,
  P6Task,
} from '../../contracts/src/p6-durable.js'

export interface P6WorkPorts {
  /** 专属管线复用同一认领续租围栏 必须自行确认任务终态 */
  handlers?: Readonly<Record<string, (task: P6Task, signal: AbortSignal) => Promise<void>>>
  /** 多轮会话由专用日志负责确认边界 必须在返回前原子完成任务或暂停 */
  conversation?(task: P6Task, signal: AbortSignal): Promise<void>
  /** 完整模型结果才允许返回 流片段中断时抛错 不得将半段文本当完成结果 */
  model(
    input: string,
    config: P6ConfigSnapshot,
    signal: AbortSignal,
    context: { runId: string; taskId: string; operationId: string; attempt: number },
  ): Promise<unknown>
  read(task: P6Task, signal: AbortSignal): Promise<unknown>
  payment: P6PaymentPort
  /** 只同步操作传入事务连接 不允许网络调用或异步提交 */
  applyPayment(db: SqliteDatabase, payment: P6Payment, result: P6PaymentResult): void
  preparePayment?(db: SqliteDatabase, payment: P6Payment, task: P6Task): void
  /** 独立故障实验在已命名边界直接退出进程 正常装配无需传入 */
  boundary?(name: string, task: P6Task): Promise<void>
}

export interface P6WorkerOptions {
  /** 公共接入只认领同事务写入接管凭据的任务 历史任务保持原状 */
  acceptedEvent?: string
  /** 专用 Worker 只认领自己支持的管线 防止误消费另一执行器的任务 */
  tools?: readonly string[]
  owner: string
  leaseMs: number
  callTimeoutMs: number
  maxAttempts: number
  retryDelayMs: number
  limits: P6Limits
}

/**
 * Worker 只续跑未确认步骤 不执行任意模型生成的资金指令
 * 资金计划来自受理前已校验的业务层 配置始终使用命令内的冻结快照
 */
export class P6Worker {
  constructor(
    private readonly repo: P6TaskRepository,
    private readonly ports: P6WorkPorts,
    private readonly options: P6WorkerOptions,
  ) {
    if (options.leaseMs < 30 || options.callTimeoutMs <= 0 || options.maxAttempts < 1) {
      throw new Error('无效 Worker 配置')
    }
  }

  async runOnce(): Promise<boolean> {
    const task = this.repo.claim(
      this.options.owner,
      this.options.leaseMs,
      this.options.limits,
      this.options.tools,
      this.options.acceptedEvent,
    )
    if (!task) return false
    const controller = new AbortController()
    const deadlineTimer = setTimeout(
      () => controller.abort(new Error('运行时间上限')),
      Math.max(0, task.deadline - Date.now()),
    )
    const heartbeat = setInterval(
      () => {
        try {
          if (!this.repo.renew(task, this.options.leaseMs)) controller.abort(new P6OwnershipLost())
          else if (this.repo.get(task.taskId)?.cancelRequested)
            controller.abort(new Error('用户请求取消'))
        } catch (error) {
          controller.abort(error)
        }
      },
      Math.max(10, Math.floor(this.options.leaseMs / 3)),
    )
    try {
      await this.ports.boundary?.('claimed', task)
      await this.execute(task, controller.signal)
    } catch (error) {
      if (error instanceof P6OwnershipLost) return true
      try {
        const current = this.repo.assertOwned(task)
        const effect = task.input.plan.payment
          ? this.repo.effect(task.input.plan.payment)
          : undefined
        const reason = error instanceof Error ? error.message : '调用异常'
        this.repo.event(task, `call-error:${task.attempt}`, { category: 'call_failure', reason })
        if (effect && effect.status !== 'succeeded' && effect.status !== 'rejected') {
          this.repo.finish(task, 'needs_confirmation', reason)
        } else if (current.cancelRequested && !effect) {
          this.repo.finish(task, 'cancelled', reason)
        } else if (task.attempt >= this.options.maxAttempts || current.deadline <= Date.now()) {
          this.repo.finish(task, 'call_failed', reason)
        } else {
          this.repo.release(task, reason, this.options.retryDelayMs)
        }
      } catch (writeError) {
        if (!(writeError instanceof P6OwnershipLost)) throw writeError
      }
    } finally {
      clearInterval(heartbeat)
      clearTimeout(deadlineTimer)
      controller.abort()
    }
    return true
  }

  /** 超时以竞速终止等待 并向底层传递取消 即使底层迟到也不能写检查点 */
  private async call<T>(
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    if (signal.aborted) abort()
    signal.addEventListener('abort', abort, { once: true })
    let rejectAbort: (() => void) | undefined
    const interrupted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason ?? new Error('调用取消'))
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
      if (controller.signal.aborted) rejectAbort()
    })
    const timeout = setTimeout(
      () => controller.abort(new Error('调用超时')),
      this.options.callTimeoutMs,
    )
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted()
          return work(controller.signal)
        }),
        interrupted,
      ])
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
    }
  }

  private async execute(task: P6Task, signal: AbortSignal): Promise<void> {
    const payment = task.input.plan.payment
    let effect = payment ? this.repo.effect(payment) : undefined
    const current = this.repo.assertOwned(task)
    const stopping = current.cancelRequested || current.deadline <= Date.now()
    if (stopping && !effect) {
      this.repo.finish(
        task,
        current.cancelRequested ? 'cancelled' : 'call_failed',
        current.cancelRequested ? '发送前取消' : '运行时间上限',
      )
      return
    }

    // 进程强退不会经过 catch 也必须在新认领时核验累计上限
    // 已发送资金的核验不受模型重试上限阻断 必须继续查询原交易
    if (!effect && task.attempt > this.options.maxAttempts) {
      this.repo.finish(task, 'call_failed', '持久任务累计尝试已达上限')
      return
    }

    const handler = this.ports.handlers?.[task.input.plan.tool]
    if (handler) {
      await this.call(signal, (s) => handler(task, s))
      return
    }

    if (task.input.plan.tool === 'conversation') {
      if (!this.ports.conversation) throw new Error('未装配持久会话执行器')
      await this.call(signal, (s) => this.ports.conversation!(task, s))
      return
    }

    // 已发送资金动作优先查询 不因模型重试取消或时间上限重新规划资金路径
    if (!effect) {
      if (this.repo.step(task.taskId, 'model') === undefined) {
        await this.ports.boundary?.('before-model', task)
        const value = await this.call(signal, (s) =>
          this.ports.model(task.input.plan.input, task.input.config, s, {
            runId: task.runId,
            taskId: task.taskId,
            operationId: `${task.commandId}:model`,
            attempt: task.attempt,
          }),
        )
        await this.ports.boundary?.('after-model-response', task)
        this.repo.checkpoint(task, 'model', value)
        await this.ports.boundary?.('after-model-checkpoint', task)
      }
      if (this.repo.step(task.taskId, 'read') === undefined) {
        const beforeRead = this.repo.assertOwned(task)
        if (beforeRead.cancelRequested || beforeRead.deadline <= Date.now()) {
          this.repo.finish(
            task,
            beforeRead.cancelRequested ? 'cancelled' : 'call_failed',
            '只读步骤前停止',
          )
          return
        }
        const value = await this.call(signal, (s) => this.ports.read(task, s))
        this.repo.checkpoint(task, 'read', value)
      }
    }

    if (payment) {
      let result: P6PaymentResult
      if (effect?.status === 'succeeded' || effect?.status === 'rejected') {
        result = effect.result!
      } else {
        const shouldSend = this.repo.beginPayment(task, payment, this.ports.preparePayment)
        effect = this.repo.effect(payment)
        if (!effect) {
          const stopped = this.repo.assertOwned(task)
          this.repo.finish(
            task,
            stopped.cancelRequested ? 'cancelled' : 'call_failed',
            '资金发送前停止',
          )
          return
        }
        await this.ports.boundary?.('after-payment-intent', task)
        // 核验使用独立的有界信号 已取消任务仍须查明已发生的资金事实
        const querySignal = new AbortController().signal
        try {
          result = shouldSend
            ? await this.call(signal, (s) => this.ports.payment.execute(payment, s))
            : await this.call(querySignal, (s) => this.ports.payment.query(payment.businessKey, s))
        } catch (error) {
          this.repo.event(task, `payment-call-error:${task.attempt}`, {
            category: 'call_failure',
            reason: error instanceof Error ? error.message : '渠道调用异常',
          })
          result = await this.call(querySignal, (s) =>
            this.ports.payment.query(payment.businessKey, s),
          )
        }
        await this.ports.boundary?.('after-payment-response', task)
        this.repo.settle(task, payment, result, this.ports.applyPayment)
        await this.ports.boundary?.('after-payment-checkpoint', task)
      }
      if (result.status === 'unknown' || result.status === 'not_found') {
        this.repo.finish(task, 'needs_confirmation', '资金结果未知 只允许查询或人工核验')
        return
      }
      if (result.status === 'rejected') {
        this.repo.finish(task, 'business_failed', result.reason)
        return
      }
    }
    // 取消不撤销已经确认的资金事实 终态事件保留动作是否已发生
    const cancelled = this.repo.assertOwned(task).cancelRequested
    this.repo.finish(
      task,
      cancelled ? 'cancelled' : 'completed',
      cancelled ? '已核验资金后停止后续工作' : null,
    )
  }
}
