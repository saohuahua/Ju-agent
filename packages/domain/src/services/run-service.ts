/**
 * Agent 运行服务
 *
 * 管理运行记录与状态迁移 事件追加统一走这里
 * runId 生成使用随机前缀 不参与业务编号序列
 */

import { randomUUID } from 'node:crypto'
import type { EventType } from '@aftersales/contracts'
import { createToolError } from '@aftersales/contracts'
import type { AgentRunRecord } from '../entities.js'
import { DomainError } from '../repositories.js'
import type { AgentRunRepository, EventRepository } from '../repositories.js'
import type { Clock } from '../clock.js'
import { toIso } from '../clock.js'
import { assertRunTransition } from '../state-machines.js'

export interface StartRunInput {
  customerId: string
  promptVersion: string
  model: string
  faultPlan?: unknown[]
}

export class RunService {
  constructor(
    private readonly runRepo: AgentRunRepository,
    private readonly eventRepo: EventRepository,
    private readonly clock: Clock,
  ) {}

  async start(input: StartRunInput): Promise<AgentRunRecord> {
    const now = toIso(this.clock.now())
    const record: AgentRunRecord = {
      runId: `run_${randomUUID().slice(0, 8)}`,
      customerId: input.customerId,
      status: 'created',
      intent: null,
      promptVersion: input.promptVersion,
      model: input.model,
      error: null,
      faultPlan: input.faultPlan ?? [],
      createdAt: now,
      updatedAt: now,
    }
    await this.runRepo.create(record)
    return record
  }

  async get(runId: string): Promise<AgentRunRecord> {
    const record = await this.runRepo.findById(runId)
    if (!record) {
      throw new DomainError(createToolError('NOT_FOUND', `运行不存在 ${runId}`))
    }
    return record
  }

  /** 带迁移校验的状态更新 非法迁移直接抛错 */
  async transition(
    runId: string,
    to: AgentRunRecord['status'],
    patch?: Partial<AgentRunRecord>,
  ): Promise<AgentRunRecord> {
    const record = await this.get(runId)
    assertRunTransition(record.status, to)
    const updated: AgentRunRecord = {
      ...record,
      ...patch,
      status: to,
      updatedAt: toIso(this.clock.now()),
    }
    await this.runRepo.update(updated)
    return updated
  }

  /** 记录识别出的业务意图 不涉及状态迁移 */
  async setIntent(runId: string, intent: string): Promise<void> {
    const record = await this.get(runId)
    await this.runRepo.update({ ...record, intent, updatedAt: toIso(this.clock.now()) })
  }

  /** 事件追加 返回分配的序号 */
  async emit(runId: string, type: EventType, payload: unknown): Promise<number> {
    return this.eventRepo.append(runId, type, payload)
  }

  async list(options?: {
    status?: string
    customerId?: string
    limit?: number
  }): Promise<AgentRunRecord[]> {
    return this.runRepo.list(options)
  }
}
