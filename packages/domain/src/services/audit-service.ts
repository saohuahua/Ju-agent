/**
 * 审计服务
 *
 * 审计日志只追加 不修改 不删除
 * 每次工具调用 审批决定与权限拒绝都留痕
 */

import type { Actor } from '../entities.js'
import type { AuditRepository } from '../repositories.js'
import type { Clock } from '../clock.js'
import { toIso } from '../clock.js'

export class AuditService {
  constructor(
    private readonly auditRepo: AuditRepository,
    private readonly clock: Clock,
  ) {}

  /** 追加审计 位置参数便于高频调用点保持单行 */
  async record(
    actor: Actor,
    action: string,
    resourceType: string,
    resourceId: string,
    detail?: Record<string, unknown>,
    runId?: string | null,
  ): Promise<void> {
    await this.auditRepo.append({
      occurredAt: toIso(this.clock.now()),
      actorRole: actor.role,
      actorId: actor.customerId ?? actor.role,
      action,
      resourceType,
      resourceId,
      detail: detail ?? {},
      runId: runId ?? null,
    })
  }
}
