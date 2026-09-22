/**
 * 满意度评分领域服务
 *
 * 会话终态后的客户评分收集 全终态可评 一 run 一评 幂等拒绝
 * 评分与评论只做收集与展示 不参与任务成败判定 与评测体系解耦
 */

import { createToolError } from '@aftersales/contracts'
import type { Actor, RunRating } from '../entities.js'
import { DomainError } from '../repositories.js'
import type { RatingRepository } from '../repositories.js'
import type { RunService } from './run-service.js'
import type { AuditService } from './audit-service.js'
import type { Clock } from '../clock.js'
import { toIso } from '../clock.js'

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'escalated', 'handling_human']

export class RatingService {
  constructor(
    private readonly runs: RunService,
    private readonly ratingRepo: RatingRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async submit(
    actor: Actor,
    runId: string,
    input: { score: number; comment?: string },
  ): Promise<RunRating> {
    if (actor.role !== 'customer' || !actor.customerId) {
      throw new DomainError(
        createToolError('AUTHORIZATION_DENIED', '仅客户可评价会话', {
          resourceType: 'run',
          resourceId: runId,
        }),
      )
    }
    const run = await this.runs.get(runId)
    if (run.customerId !== actor.customerId) {
      throw new DomainError(
        createToolError('AUTHORIZATION_DENIED', '只能评价自己的会话', {
          resourceType: 'run',
          resourceId: runId,
        }),
      )
    }
    if (!TERMINAL_STATUSES.includes(run.status)) {
      throw new DomainError(
        createToolError('CONFLICT', `会话尚未结束 当前状态 ${run.status} 暂不可评价`, {
          resourceType: 'run',
          resourceId: runId,
        }),
      )
    }
    const existing = await this.ratingRepo.findByRunId(runId)
    if (existing) {
      throw new DomainError(
        createToolError('CONFLICT', '该会话已评价 不可重复提交', {
          resourceType: 'run',
          resourceId: runId,
        }),
      )
    }
    if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
      throw new DomainError(
        createToolError('VALIDATION_ERROR', '评分须为 1 到 5 的整数', {
          resourceType: 'run',
          resourceId: runId,
        }),
      )
    }
    const rating: RunRating = {
      runId,
      score: input.score,
      comment: input.comment?.trim() ? input.comment.trim() : null,
      submittedAt: toIso(this.clock.now()),
    }
    await this.ratingRepo.create(rating)
    await this.audit.record(
      actor,
      'run_rated',
      'run',
      runId,
      { score: rating.score, comment: rating.comment },
      runId,
    )
    return rating
  }

  async findByRunId(runId: string): Promise<RunRating | null> {
    return this.ratingRepo.findByRunId(runId)
  }
}
