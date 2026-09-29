/**
 * 空闲会话收尾
 *
 * 只处理 source=customer 且 awaiting_input 超过 TTL 的会话
 * 在途任务与退款关联由注入的守卫拦截 本服务不直接查表
 * 收尾走 cancelled 并落 run.expired 与客户主动结束咨询区分
 */

import type { AgentRunRecord } from '../entities.js'
import type { Clock } from '../clock.js'
import { DomainError } from '../repositories.js'
import type { RunService } from './run-service.js'

export interface SessionExpiryGuards {
  isBusy(runId: string): boolean
  hasRefundLink(runId: string): boolean
}

export interface SessionExpiryOptions {
  runs: RunService
  clock: Clock
  ttlHours: number
  guards: SessionExpiryGuards
}

export class SessionExpiryService {
  constructor(private readonly options: SessionExpiryOptions) {
    if (!Number.isFinite(options.ttlHours) || options.ttlHours <= 0) {
      throw new Error('SESSION_IDLE_TTL_HOURS 必须为正数')
    }
  }

  /**
   * 扫描并收尾到期会话
   *
   * 前置 调用方负责周期调度
   * 异常路径 单条 CAS 冲突或非法迁移时跳过 不中断批次
   */
  async expireDue(limit = 200): Promise<string[]> {
    const now = this.options.clock.now()
    const cutoff = new Date(now.getTime() - this.options.ttlHours * 3600 * 1000)
    const candidates = await this.options.runs.list({ status: 'awaiting_input', limit })
    const expired: string[] = []
    for (const run of candidates) {
      if (!this.shouldExpire(run, cutoff)) continue
      try {
        await this.options.runs.transition(run.runId, 'cancelled', undefined, 'awaiting_input')
        const idleHours = Math.max(0, (now.getTime() - Date.parse(run.updatedAt)) / 3600 / 1000)
        await this.options.runs.emit(run.runId, 'run.expired', {
          reason: 'idle_ttl',
          idleHours,
          lastActiveAt: run.updatedAt,
        })
        expired.push(run.runId)
      } catch (error) {
        if (error instanceof DomainError && error.shape.code === 'CONFLICT') continue
        throw error
      }
    }
    return expired
  }

  private shouldExpire(run: AgentRunRecord, cutoff: Date): boolean {
    if (run.source !== 'customer') return false
    if (run.status !== 'awaiting_input') return false
    if (Date.parse(run.updatedAt) >= cutoff.getTime()) return false
    if (this.options.guards.isBusy(run.runId)) return false
    if (this.options.guards.hasRefundLink(run.runId)) return false
    return true
  }
}
