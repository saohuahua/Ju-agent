/**
 * 人工接管领域服务
 *
 * escalated 会话的收口通道 坐席接管 对话与标记解决
 * AI 循环不参与人工回合 消息直接落事件流 客户与坐席两端经 SSE 实时可见
 * 接管 消息与解决全部审计留痕 角色门槛在领域层再加一道防线
 */

import { createToolError } from '@aftersales/contracts'
import type { Actor } from '../entities.js'
import { DomainError } from '../repositories.js'
import type { RunService } from './run-service.js'
import type { AuditService } from './audit-service.js'

export class HumanHandoverService {
  constructor(
    private readonly runs: RunService,
    private readonly audit: AuditService,
  ) {}

  /** 坐席接管 escalated 会话 迁往 handling_human 人工处理中 */
  async takeOver(actor: Actor, runId: string): Promise<void> {
    this.assertOperator(actor, '接管会话')
    const run = await this.runs.get(runId)
    if (run.status !== 'escalated') {
      throw new DomainError(
        createToolError('CONFLICT', `仅升级人工的会话可接管 当前状态 ${run.status}`, {
          resourceType: 'run',
          resourceId: runId,
        }),
      )
    }
    await this.runs.transition(runId, 'handling_human')
    const takenBy = actor.customerId ?? actor.role
    await this.runs.emit(runId, 'run.handover', { takenBy })
    await this.audit.record(actor, 'run_handover_taken', 'run', runId, { takenBy }, runId)
  }

  /** 坐席消息 人工处理中直接落事件 不驱动模型 */
  async appendOperatorMessage(actor: Actor, runId: string, text: string): Promise<void> {
    this.assertOperator(actor, '发送坐席消息')
    await this.assertHandling(runId)
    const sentBy = actor.customerId ?? actor.role
    await this.runs.emit(runId, 'operator.message', { text, sentBy })
    await this.audit.record(actor, 'operator_message_sent', 'run', runId, { sentBy }, runId)
  }

  /** 客户消息 人工处理中直接落事件 坐席端经 SSE 实时可见 */
  async appendCustomerMessage(actor: Actor, runId: string, text: string): Promise<void> {
    if (actor.role !== 'customer' || !actor.customerId) {
      throw new DomainError(
        createToolError('AUTHORIZATION_DENIED', '仅客户可在人工会话中留言', {
          resourceType: 'run',
          resourceId: runId,
        }),
      )
    }
    await this.assertHandling(runId)
    await this.runs.emit(runId, 'message.user', { text })
  }

  /** 坐席标记解决 附解决摘要 迁回 completed 终态 */
  async resolve(actor: Actor, runId: string, summary: string): Promise<void> {
    this.assertOperator(actor, '标记解决')
    await this.assertHandling(runId)
    await this.runs.transition(runId, 'completed')
    const resolvedBy = actor.customerId ?? actor.role
    await this.runs.emit(runId, 'run.resolved', { summary, resolvedBy })
    await this.audit.record(actor, 'run_resolved', 'run', runId, { summary, resolvedBy }, runId)
  }

  private assertOperator(actor: Actor, action: string): void {
    if (actor.role !== 'operator' && actor.role !== 'supervisor') {
      throw new DomainError(
        createToolError('AUTHORIZATION_DENIED', `仅操作员可${action}`, {
          resourceType: 'run',
        }),
      )
    }
  }

  private async assertHandling(runId: string): Promise<void> {
    const run = await this.runs.get(runId)
    if (run.status !== 'handling_human') {
      throw new DomainError(
        createToolError('CONFLICT', `会话不在人工处理中 当前状态 ${run.status}`, {
          resourceType: 'run',
          resourceId: runId,
        }),
      )
    }
  }
}
