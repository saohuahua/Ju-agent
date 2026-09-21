/**
 * 确定性工作流引擎
 *
 * Agent 只负责理解与决策 副作用路径全部固化在这里
 * 引擎保证
 *   每步先写事件再执行 执行后立即保存断点
 *   高风险动作前必须经过审批 暂停等待人工决定
 *   断点恢复跳过已完成步骤 重试不会重复副作用
 *   租约防止同一运行被并发执行
 */

import type { Actor } from '@aftersales/domain'
import type {
  AfterSaleService,
  ApprovalService,
  CheckpointRepository,
  Clock,
  CompensationService,
  LeaseRepository,
  PriceProtectionService,
  RunService,
} from '@aftersales/domain'
import { DomainError } from '@aftersales/domain'
import type { Intent, ToolErrorShape } from '@aftersales/contracts'
import { createToolError } from '@aftersales/contracts'
import type { ToolExecutor } from '@aftersales/tools'
import { ProcessCrashError } from '@aftersales/tools'
import type { ToolContext } from '@aftersales/tools'

/** 工作流执行结果 回给 Agent 循环决定下一步话术 */
export type WorkflowResult =
  | {
      status: 'completed'
      outcome: 'succeeded' | 'rejected' | 'cancelled' | 'escalated'
      summary: Record<string, unknown>
    }
  | {
      status: 'paused'
      pauseKind: 'approval'
      approvalId: string
      summary: Record<string, unknown>
    }
  | { status: 'failed'; error: ToolErrorShape }

/** 步骤暂停信号 */
interface PauseForApproval {
  pauseForApproval: true
  approvalId: string
}

/** 工作流步骤定义 */
export interface WorkflowStep {
  id: string
  name: string
  execute: (context: WorkflowRunContext) => Promise<PauseForApproval | void>
}

/** 工作流运行上下文 state 随断点持久化 */
export interface WorkflowRunContext {
  runId: string
  actor: Actor
  intent: Intent
  slots: Record<string, unknown>
  state: Record<string, unknown>
  /** 工具执行上下文 含故障控制器 */
  toolContext: ToolContext
}

export interface WorkflowEngineDeps {
  afterSaleService: AfterSaleService
  compensationService: CompensationService
  priceProtectionService: PriceProtectionService
  approvalService: ApprovalService
  runService: RunService
  executor: ToolExecutor
  checkpointRepo: CheckpointRepository
  leaseRepo: LeaseRepository
  clock: Clock
}

/** 断点内保存的进度标记 */
const COMPLETED_STEPS = 'completedSteps'

export class WorkflowEngine {
  constructor(private readonly deps: WorkflowEngineDeps) {}

  /**
   * 启动工作流
   *
   * 意图到步骤集的映射在 definitions 中声明
   * 执行中遇到审批即暂停 状态与进度全部落断点
   */
  async start(
    runId: string,
    intent: Intent,
    slots: Record<string, unknown>,
    toolContext: ToolContext,
  ): Promise<WorkflowResult> {
    const context: WorkflowRunContext = {
      runId,
      actor: toolContext.actor,
      intent,
      slots,
      state: { [COMPLETED_STEPS]: [] as string[] },
      toolContext,
    }
    return this.runSteps(context, this.stepsFor(intent))
  }

  /**
   * 审批决定后恢复
   *
   * 决定先落业务状态 再续跑剩余步骤
   * 拒绝与过期直接收尾 不再执行副作用
   */
  async resumeAfterApproval(
    runId: string,
    approvalId: string,
    decision: 'approved' | 'rejected' | 'expired',
    decidedBy: string,
    toolContext: ToolContext,
  ): Promise<WorkflowResult> {
    const checkpoint = await this.deps.checkpointRepo.latest(runId)
    if (!checkpoint) {
      throw new DomainError(createToolError('NOT_FOUND', `运行没有断点 ${runId}`))
    }
    const state = checkpoint.state as Record<string, unknown>
    const returnNo = state.returnNo as string | undefined
    const intent = state.intent as Intent
    const slots = (state.slots ?? {}) as Record<string, unknown>
    // 审批关联的业务资源类型 旧断点无此字段 默认售后单
    const approvalResourceType = (state.approvalResourceType as string) ?? 'return_request'

    await this.deps.runService.emit(runId, 'approval.decided', { approvalId, decision, decidedBy })

    // 决定先落业务状态 再续跑剩余步骤 拒绝与过期直接收尾 不再执行副作用
    const supervisorActor: Actor = { role: 'supervisor' }
    if (approvalResourceType === 'compensation') {
      const compensationNo = state.compensationNo as string | undefined
      if (compensationNo) {
        await this.deps.compensationService.applyApprovalDecision(
          supervisorActor,
          compensationNo,
          decision,
          runId,
        )
      }
    } else if (approvalResourceType === 'price_protection') {
      const protectionNo = state.protectionNo as string | undefined
      if (protectionNo) {
        await this.deps.priceProtectionService.applyApprovalDecision(
          supervisorActor,
          protectionNo,
          decision,
          runId,
        )
      }
    } else if (returnNo) {
      await this.deps.afterSaleService.applyApprovalDecision(
        supervisorActor,
        returnNo,
        decision,
        runId,
      )
    }

    await this.deps.runService.transition(runId, 'running')
    await this.deps.runService.emit(runId, 'run.resumed', { resumePoint: 'approval' })

    if (decision !== 'approved') {
      const closedText =
        approvalResourceType === 'compensation'
          ? '补偿单已关闭'
          : approvalResourceType === 'price_protection'
            ? '价保单已关闭'
            : '售后单已关闭'
      return {
        status: 'completed',
        outcome: 'rejected',
        summary: {
          returnNo,
          decision,
          explanation:
            decision === 'rejected'
              ? `审批已拒绝 ${closedText}`
              : `审批已过期 ${closedText} 可重新发起`,
        },
      }
    }

    const context: WorkflowRunContext = {
      runId,
      actor: toolContext.actor,
      intent,
      slots,
      state,
      toolContext,
    }
    const result = await this.runSteps(context, this.stepsFor(intent))
    // 审批通过后覆写摘要 恢复时的断点状态里 policyOutcome 仍是历史的 needs_approval
    // 若不覆写 模型读到 needs_approval 会误以为仍待审批 继续输出等待话术
    // 模型可感知的最终结论必须显式是 approved
    if (result.status !== 'failed') {
      result.summary = {
        ...result.summary,
        policyOutcome: 'approved',
        policyExplanation: '人工审批已通过 业务动作已执行',
        decision: 'approved',
      }
    }
    return result
  }

  /**
   * 断点恢复
   *
   * 进程中断或执行卡死后由此续跑
   * 已完成步骤直接跳过 副作用工具自身幂等 双保险
   */
  async resumeFromCheckpoint(runId: string, toolContext: ToolContext): Promise<WorkflowResult> {
    const checkpoint = await this.deps.checkpointRepo.latest(runId)
    if (!checkpoint) {
      throw new DomainError(createToolError('NOT_FOUND', `运行没有断点 ${runId}`))
    }
    const state = checkpoint.state as Record<string, unknown>
    const intent = state.intent as Intent
    const slots = (state.slots ?? {}) as Record<string, unknown>
    const run = await this.deps.runService.get(runId)

    if (run.status !== 'running') {
      throw new DomainError(
        createToolError('CONFLICT', `运行状态 ${run.status} 不支持断点恢复 请走审批或补问通道`),
      )
    }

    await this.deps.runService.emit(runId, 'run.resumed', { resumePoint: 'checkpoint' })
    const context: WorkflowRunContext = {
      runId,
      actor: toolContext.actor,
      intent,
      slots,
      state,
      toolContext,
    }
    return this.runSteps(context, this.stepsFor(intent))
  }

  /** 步骤执行主循环 含事件 断点 租约与异常归一 */
  private async runSteps(
    context: WorkflowRunContext,
    steps: WorkflowStep[],
  ): Promise<WorkflowResult> {
    // 意图与槽位进断点 恢复时无需依赖运行记录
    context.state.intent = context.intent
    context.state.slots = context.slots

    const leaseAcquired = await this.deps.leaseRepo.acquire(
      `engine:${context.runId}`,
      'workflow_run',
      context.runId,
      60_000,
    )
    if (!leaseAcquired) {
      throw new DomainError(createToolError('CONFLICT', `运行 ${context.runId} 已有执行实例`))
    }

    try {
      const completed = new Set<string>((context.state[COMPLETED_STEPS] as string[]) ?? [])
      for (const step of steps) {
        if (completed.has(step.id)) {
          await this.deps.runService.emit(context.runId, 'step.completed', {
            stepId: step.id,
            outcome: 'skipped',
          })
          continue
        }

        await this.deps.runService.emit(context.runId, 'step.started', {
          stepId: step.id,
          stepName: step.name,
        })
        try {
          const pause = await step.execute(context)
          if (pause?.pauseForApproval) {
            completed.add(step.id)
            context.state[COMPLETED_STEPS] = [...completed]
            await this.deps.checkpointRepo.save(context.runId, step.id, context.state)
            await this.deps.runService.transition(context.runId, 'awaiting_approval')
            return {
              status: 'paused',
              pauseKind: 'approval',
              approvalId: pause.approvalId,
              summary: this.summarize(context),
            }
          }
        } catch (error) {
          if (error instanceof ProcessCrashError) {
            // 进程中断语义 不写失败状态 断点已保存到上一步 直接向上抛
            throw error
          }
          const shape =
            error instanceof DomainError
              ? error.shape
              : createToolError(
                  'INTERNAL_ERROR',
                  error instanceof Error ? error.message : String(error),
                )
          return { status: 'failed', error: shape }
        }

        completed.add(step.id)
        context.state[COMPLETED_STEPS] = [...completed]
        await this.deps.checkpointRepo.save(context.runId, step.id, context.state)
        await this.deps.runService.emit(context.runId, 'step.completed', {
          stepId: step.id,
          outcome: 'ok',
        })
      }

      return {
        status: 'completed',
        outcome: this.outcomeFor(context),
        summary: this.summarize(context),
      }
    } finally {
      await this.deps.leaseRepo.release(`engine:${context.runId}`, 'workflow_run', context.runId)
    }
  }

  /** 意图到步骤集映射 副作用路径的全部知识都在这里 */
  private stepsFor(intent: Intent): WorkflowStep[] {
    switch (intent) {
      case 'submit_refund_only':
        return this.refundOnlySteps()
      case 'submit_return':
        return this.returnSteps('return')
      case 'submit_exchange':
        return this.returnSteps('exchange')
      case 'cancel_return':
        return this.cancelSteps()
      case 'compensation':
        return this.compensationSteps()
      case 'price_protection':
        return this.priceProtectionSteps()
      case 'escalate':
        return this.escalateSteps()
      default:
        throw new DomainError(createToolError('VALIDATION_ERROR', `意图 ${intent} 没有关联工作流`))
    }
  }

  /** 仅退款 未发货取消或丢件 审批后直接执行 */
  private refundOnlySteps(): WorkflowStep[] {
    return [
      {
        id: 'verify_order',
        name: '校验订单归属与状态',
        execute: async (context) => {
          // 工作流不信任 Agent 的查询结果 自行重查一遍
          const order = await this.deps.executor.execute(
            'get_order',
            { orderNo: context.slots.orderNo as string },
            context.toolContext,
          )
          context.state.orderStatus = order.status
        },
      },
      {
        id: 'create_return',
        name: '创建售后单并完成政策判定',
        execute: async (context) => {
          const result = await this.deps.executor.execute(
            'create_return_request',
            {
              orderNo: context.slots.orderNo as string,
              type: 'refund_only',
              reason: context.slots.reason as never,
            },
            context.toolContext,
          )
          context.state.returnNo = result.returnNo
          context.state.refundNo = result.refundNo
          context.state.policyOutcome = result.policyOutcome
          context.state.policyExplanation = result.policyExplanation
          context.state.refundAmountCents = result.refundAmountCents
          context.state.requiresApproval = result.requiresApproval
        },
      },
      {
        id: 'request_approval',
        name: '发起大额或例外审批',
        execute: async (context) => {
          if (context.state.requiresApproval !== true) {
            return
          }
          const approval = await this.deps.approvalService.create({
            runId: context.runId,
            resourceType: 'return_request',
            resourceId: context.state.returnNo as string,
            reason: context.state.policyExplanation as string,
            amountCents: context.state.refundAmountCents as number,
            requestedBy: 'workflow',
          })
          context.state.approvalId = approval.approvalId
          context.state.approvalResourceType = 'return_request'
          // 令牌只存在断点与服务端 不经过模型
          context.state.approvalToken = approval.oneTimeToken
          await this.deps.runService.emit(context.runId, 'approval.required', {
            approvalId: approval.approvalId,
            riskLevel: 'high',
            resourceType: 'return_request',
            resourceId: context.state.returnNo as string,
            amountCents: approval.amountCents,
            reason: approval.reason,
            expiresAt: approval.expiresAt,
          })
          return { pauseForApproval: true, approvalId: approval.approvalId }
        },
      },
      {
        id: 'execute_refund',
        name: '执行原路退款',
        execute: async (context) => {
          if (context.state.policyOutcome === 'deny') {
            return
          }
          const args: Record<string, unknown> = { returnNo: context.state.returnNo as string }
          if (context.state.approvalToken) {
            args.approvalToken = context.state.approvalToken
          }
          const result = await this.deps.executor.execute(
            'execute_refund',
            args,
            context.toolContext,
          )
          context.state.refundStatus = result.status
          context.state.executedRefundNo = result.refundNo
        },
      },
    ]
  }

  /** 退货退款与换货 创建后等待寄回 退款在收货时联动 */
  private returnSteps(type: 'return' | 'exchange'): WorkflowStep[] {
    return [
      {
        id: 'verify_order',
        name: '校验订单归属与状态',
        execute: async (context) => {
          const order = await this.deps.executor.execute(
            'get_order',
            { orderNo: context.slots.orderNo as string },
            context.toolContext,
          )
          context.state.orderStatus = order.status
        },
      },
      {
        id: 'create_return',
        name: '创建售后单并完成政策判定',
        execute: async (context) => {
          const result = await this.deps.executor.execute(
            'create_return_request',
            {
              orderNo: context.slots.orderNo as string,
              type,
              reason: context.slots.reason as never,
              itemIds: context.slots.itemIds as string[] | undefined,
            },
            context.toolContext,
          )
          context.state.returnNo = result.returnNo
          context.state.refundNo = result.refundNo
          context.state.policyOutcome = result.policyOutcome
          context.state.policyExplanation = result.policyExplanation
          context.state.refundAmountCents = result.refundAmountCents
          context.state.requiresApproval = result.requiresApproval
        },
      },
      {
        id: 'request_approval',
        name: '发起大额或例外审批',
        execute: async (context) => {
          if (context.state.requiresApproval !== true) {
            return
          }
          const approval = await this.deps.approvalService.create({
            runId: context.runId,
            resourceType: 'return_request',
            resourceId: context.state.returnNo as string,
            reason: context.state.policyExplanation as string,
            amountCents: context.state.refundAmountCents as number,
            requestedBy: 'workflow',
          })
          context.state.approvalId = approval.approvalId
          context.state.approvalResourceType = 'return_request'
          context.state.approvalToken = approval.oneTimeToken
          await this.deps.runService.emit(context.runId, 'approval.required', {
            approvalId: approval.approvalId,
            riskLevel: 'high',
            resourceType: 'return_request',
            resourceId: context.state.returnNo as string,
            amountCents: approval.amountCents,
            reason: approval.reason,
            expiresAt: approval.expiresAt,
          })
          return { pauseForApproval: true, approvalId: approval.approvalId }
        },
      },
    ]
  }

  /**
   * 现金红包补偿 分级审批后原路发放
   * 小额自动 大额经审批 同一订单同一原因由领域层幂等拦截
   */
  private compensationSteps(): WorkflowStep[] {
    return [
      {
        id: 'verify_order',
        name: '校验订单归属与状态',
        execute: async (context) => {
          // 工作流不信任 Agent 的查询结果 自行重查一遍
          const order = await this.deps.executor.execute(
            'get_order',
            { orderNo: context.slots.orderNo as string },
            context.toolContext,
          )
          context.state.orderStatus = order.status
        },
      },
      {
        id: 'create_compensation',
        name: '创建补偿单并完成分级判定',
        execute: async (context) => {
          const result = await this.deps.executor.execute(
            'create_compensation',
            {
              orderNo: context.slots.orderNo as string,
              reason: context.slots.reason as never,
              amountCents: context.slots.amountCents as number,
            },
            context.toolContext,
          )
          context.state.compensationNo = result.compensationNo
          context.state.requiresApproval = result.requiresApproval
          context.state.policyExplanation = result.policyExplanation
          context.state.amountCents = result.amountCents
        },
      },
      {
        id: 'request_approval',
        name: '发起大额补偿审批',
        execute: async (context) => {
          if (context.state.requiresApproval !== true) {
            return
          }
          const approval = await this.deps.approvalService.create({
            runId: context.runId,
            resourceType: 'compensation',
            resourceId: context.state.compensationNo as string,
            reason: context.state.policyExplanation as string,
            amountCents: context.state.amountCents as number,
            requestedBy: 'workflow',
          })
          context.state.approvalId = approval.approvalId
          context.state.approvalResourceType = 'compensation'
          // 令牌只存在断点与服务端 不经过模型
          context.state.approvalToken = approval.oneTimeToken
          await this.deps.runService.emit(context.runId, 'approval.required', {
            approvalId: approval.approvalId,
            riskLevel: 'high',
            resourceType: 'compensation',
            resourceId: context.state.compensationNo as string,
            amountCents: approval.amountCents,
            reason: approval.reason,
            expiresAt: approval.expiresAt,
          })
          return { pauseForApproval: true, approvalId: approval.approvalId }
        },
      },
      {
        id: 'execute_compensation',
        name: '执行现金红包发放',
        execute: async (context) => {
          const args: Record<string, unknown> = {
            compensationNo: context.state.compensationNo as string,
          }
          if (context.state.approvalToken) {
            args.approvalToken = context.state.approvalToken
          }
          const result = await this.deps.executor.execute(
            'execute_compensation',
            args,
            context.toolContext,
          )
          context.state.compensationStatus = result.status
        },
      },
    ]
  }

  /**
   * 价保差价退还 创建时政策判定 拒赔直接收尾
   * 差价金额由系统按 SKU 明细计算 大额走审批
   */
  private priceProtectionSteps(): WorkflowStep[] {
    return [
      {
        id: 'verify_order',
        name: '校验订单归属与状态',
        execute: async (context) => {
          // 工作流不信任 Agent 的查询结果 自行重查一遍
          const order = await this.deps.executor.execute(
            'get_order',
            { orderNo: context.slots.orderNo as string },
            context.toolContext,
          )
          context.state.orderStatus = order.status
        },
      },
      {
        id: 'create_price_protection',
        name: '创建价保单并完成政策判定',
        execute: async (context) => {
          const args: Record<string, unknown> = {
            orderNo: context.slots.orderNo as string,
          }
          if (context.slots.itemIds) {
            args.itemIds = context.slots.itemIds as string[]
          }
          const result = await this.deps.executor.execute(
            'create_price_protection',
            args,
            context.toolContext,
          )
          context.state.protectionNo = result.protectionNo
          context.state.policyOutcome = result.policyOutcome
          context.state.policyExplanation = result.policyExplanation
          context.state.refundAmountCents = result.refundAmountCents
          context.state.requiresApproval = result.requiresApproval
        },
      },
      {
        id: 'request_approval',
        name: '发起大额差价审批',
        execute: async (context) => {
          if (context.state.requiresApproval !== true) {
            return
          }
          const approval = await this.deps.approvalService.create({
            runId: context.runId,
            resourceType: 'price_protection',
            resourceId: context.state.protectionNo as string,
            reason: context.state.policyExplanation as string,
            amountCents: context.state.refundAmountCents as number,
            requestedBy: 'workflow',
          })
          context.state.approvalId = approval.approvalId
          context.state.approvalResourceType = 'price_protection'
          // 令牌只存在断点与服务端 不经过模型
          context.state.approvalToken = approval.oneTimeToken
          await this.deps.runService.emit(context.runId, 'approval.required', {
            approvalId: approval.approvalId,
            riskLevel: 'high',
            resourceType: 'price_protection',
            resourceId: context.state.protectionNo as string,
            amountCents: approval.amountCents,
            reason: approval.reason,
            expiresAt: approval.expiresAt,
          })
          return { pauseForApproval: true, approvalId: approval.approvalId }
        },
      },
      {
        id: 'execute_price_protection',
        name: '执行差价退还',
        execute: async (context) => {
          if (context.state.policyOutcome === 'deny') {
            return
          }
          const args: Record<string, unknown> = {
            protectionNo: context.state.protectionNo as string,
          }
          if (context.state.approvalToken) {
            args.approvalToken = context.state.approvalToken
          }
          const result = await this.deps.executor.execute(
            'execute_price_protection',
            args,
            context.toolContext,
          )
          context.state.protectionStatus = result.status
        },
      },
    ]
  }

  /** 取消售后单 单步工作流 */
  private cancelSteps(): WorkflowStep[] {
    return [
      {
        id: 'cancel_return',
        name: '取消售后单',
        execute: async (context) => {
          const result = await this.deps.executor.execute(
            'cancel_return_request',
            { returnNo: context.slots.returnNo as string },
            context.toolContext,
          )
          context.state.returnNo = result.returnNo
          context.state.returnStatus = result.status
        },
      },
    ]
  }

  /** 升级人工 单步工作流 */
  private escalateSteps(): WorkflowStep[] {
    return [
      {
        id: 'escalate',
        name: '升级人工客服',
        execute: async (context) => {
          await this.deps.executor.execute(
            'escalate_to_human',
            { reason: (context.slots.reason as string) ?? '用户请求人工' },
            context.toolContext,
          )
        },
      },
    ]
  }

  /** 根据断点状态归纳结果 */
  private outcomeFor(
    context: WorkflowRunContext,
  ): 'succeeded' | 'rejected' | 'cancelled' | 'escalated' {
    if (context.state.policyOutcome === 'deny') {
      return 'rejected'
    }
    if (context.intent === 'cancel_return') {
      return 'cancelled'
    }
    if (context.intent === 'escalate') {
      return 'escalated'
    }
    return 'succeeded'
  }

  /** 给 Agent 的结果摘要 字段名保持稳定 便于提示词解释 */
  private summarize(context: WorkflowRunContext): Record<string, unknown> {
    return {
      intent: context.intent,
      returnNo: context.state.returnNo ?? null,
      refundNo: context.state.refundNo ?? null,
      policyOutcome: context.state.policyOutcome ?? null,
      policyExplanation: context.state.policyExplanation ?? null,
      refundAmountCents: context.state.refundAmountCents ?? null,
      refundStatus: context.state.refundStatus ?? null,
      compensationNo: context.state.compensationNo ?? null,
      compensationStatus: context.state.compensationStatus ?? null,
      protectionNo: context.state.protectionNo ?? null,
      protectionStatus: context.state.protectionStatus ?? null,
      amountCents: context.state.amountCents ?? null,
    }
  }
}
