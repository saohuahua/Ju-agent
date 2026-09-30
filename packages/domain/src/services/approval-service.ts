/**
 * 审批服务
 *
 * 高风险动作的人工把关
 * 决定通过条件更新落库 并发重复提交只有一个生效
 * 一次性令牌绑定资源 执行侧必须出示且只能消费一次
 */

import { randomUUID } from 'node:crypto'
import { assertApprovalTransition } from '../state-machines.js'
import type { Actor } from '../entities.js'
import { DomainError } from '../repositories.js'
import type { ApprovalRepository } from '../repositories.js'
import type { ApprovalRequest } from '../entities.js'
import type { Clock } from '../clock.js'
import { toIso } from '../clock.js'
import { createToolError } from '@aftersales/contracts'

/** 审批有效期 演示环境 30 分钟 */
export const APPROVAL_TTL_MS = 30 * 60 * 1000

export interface CreateApprovalInput {
  runId: string | null
  resourceType: string
  resourceId: string
  reason: string
  amountCents: number
  requestedBy: string
}

export type DecideResult =
  | { outcome: 'decided'; approval: ApprovalRequest }
  | { outcome: 'already_decided'; approval: ApprovalRequest }
  | { outcome: 'expired'; approval: ApprovalRequest }
  | { outcome: 'conflict'; approval: ApprovalRequest }

export class ApprovalService {
  constructor(
    private readonly approvalRepo: ApprovalRepository,
    private readonly clock: Clock,
  ) {}

  /** 创建审批请求并生成一次性令牌 令牌只在服务端与审批记录中流转 */
  async create(input: CreateApprovalInput): Promise<ApprovalRequest> {
    const approval = this.prepare(input)
    await this.approvalRepo.create(approval)
    return approval
  }

  /** 生成原审批契约 由持久受理事务同步保存 */
  prepare(input: CreateApprovalInput): ApprovalRequest {
    const now = this.clock.now()
    const approval: ApprovalRequest = {
      approvalId: `apr_${randomUUID().slice(0, 8)}`,
      runId: input.runId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      reason: input.reason,
      amountCents: input.amountCents,
      status: 'pending',
      oneTimeToken: `tok_${randomUUID().replaceAll('-', '')}`,
      requestedBy: input.requestedBy,
      decidedBy: null,
      decidedAt: null,
      expiresAt: toIso(new Date(now.getTime() + APPROVAL_TTL_MS)),
      createdAt: toIso(now),
    }
    return approval
  }

  /** 待审批列表 供审批中心与评测驱动 */
  async listPending(): Promise<ApprovalRequest[]> {
    return this.approvalRepo.listPending()
  }

  /**
   * 审批决定
   * 状态不是 pending 时返回 already_decided 不产生第二次副作用
   * 数据库条件更新同时检查有效期 避免读取之后状态被其他请求覆盖
   */
  async decide(
    actor: Actor,
    approvalId: string,
    decision: 'approved' | 'rejected',
    runId?: string,
    checkpointId?: number,
  ): Promise<DecideResult> {
    if (actor.role !== 'supervisor') {
      throw new DomainError(createToolError('AUTHORIZATION_DENIED', '审批决定仅限主管'))
    }
    const approval = await this.approvalRepo.findById(approvalId)
    if (!approval) {
      throw new DomainError(createToolError('NOT_FOUND', `审批请求不存在 ${approvalId}`))
    }
    if (approval.status === 'expired' || this.isExpired(approval)) {
      return { outcome: 'expired', approval }
    }
    if (approval.status !== 'pending') {
      return { outcome: 'already_decided', approval }
    }
    assertApprovalTransition(approval.status, decision)
    const decided = await this.approvalRepo.decidePending({
      approvalId,
      decision,
      decidedBy: actor.customerId ?? actor.role,
      now: toIso(this.clock.now()),
      runId,
      checkpointId,
    })
    if (decided) return { outcome: 'decided', approval: decided }

    // 竞争失败后重读事实 决定已被处理与运行前置条件变化分别返回
    const current = await this.approvalRepo.findById(approvalId)
    if (!current) throw new DomainError(createToolError('NOT_FOUND', '审批请求已不存在'))
    if (current.status === 'expired' || this.isExpired(current))
      return { outcome: 'expired', approval: current }
    return {
      outcome: current.status === 'pending' ? 'conflict' : 'already_decided',
      approval: current,
    }
  }

  /**
   * 消费一次性令牌
   * 高风险工具执行前调用 令牌必须匹配资源且审批已通过
   * 消费后置空令牌字段 二次出示必然失败
   */
  async consumeToken(
    token: string,
    resourceType: string,
    resourceId: string,
  ): Promise<{ ok: true; approval: ApprovalRequest } | { ok: false; error: DomainError }> {
    const approval = await this.approvalRepo.findByResource(resourceType, resourceId)
    if (!approval) {
      return {
        ok: false,
        error: new DomainError(createToolError('APPROVAL_TOKEN_INVALID', '该资源不存在审批记录')),
      }
    }
    if (approval.status === 'expired' || this.isExpired(approval)) {
      return {
        ok: false,
        error: new DomainError(createToolError('APPROVAL_EXPIRED', '审批已过期')),
      }
    }
    if (!token || approval.status !== 'approved' || approval.oneTimeToken !== token) {
      return {
        ok: false,
        error: new DomainError(createToolError('APPROVAL_TOKEN_INVALID', '审批令牌无效或未批准')),
      }
    }
    const consumed = await this.approvalRepo.consumeToken(
      approval.approvalId,
      token,
      resourceType,
      resourceId,
      toIso(this.clock.now()),
    )
    if (!consumed) {
      return {
        ok: false,
        error: new DomainError(
          createToolError('APPROVAL_TOKEN_INVALID', '审批令牌已消费或不再有效'),
        ),
      }
    }
    return { ok: true, approval: { ...approval, oneTimeToken: '' } }
  }

  /** 审批是否过期 供工作流在恢复时检查 */
  isExpired(approval: ApprovalRequest): boolean {
    return new Date(approval.expiresAt).getTime() <= this.clock.now().getTime()
  }

  /** 工作流只能应用与当前运行和资源一致的已存决定 */
  async assertStoredDecision(
    runId: string,
    approvalId: string,
    resourceType: string,
    resourceId: string,
    decision: 'approved' | 'rejected' | 'expired',
  ): Promise<void> {
    const approval = await this.approvalRepo.findById(approvalId)
    if (
      !approval ||
      approval.runId !== runId ||
      approval.resourceType !== resourceType ||
      approval.resourceId !== resourceId
    ) {
      throw new DomainError(createToolError('CONFLICT', '审批与恢复资源不匹配'))
    }
    const expired = approval.status === 'expired' || this.isExpired(approval)
    if (decision === 'expired' ? !expired : approval.status !== decision || expired) {
      throw new DomainError(
        createToolError(expired ? 'APPROVAL_EXPIRED' : 'CONFLICT', '恢复决定与审批事实不一致'),
      )
    }
  }
}
