import type { Actor, AgentRunRecord } from './entities.js'

export type ClosureResourceType =
  | 'refund'
  | 'compensation'
  | 'price_protection'
  | 'return_request'
  | 'approval'
  | 'execution'
  | 'evidence'
  | 'task'
  | 'payment_effect'

export interface ClosureResource {
  resourceType: ClosureResourceType
  resourceId: string
  status: string
}

export interface ClosureBlocker extends ClosureResource {
  reason: string
}

export interface CaseClosureReview {
  runId: string
  status: AgentRunRecord['status']
  canResolve: boolean
  blockers: ClosureBlocker[]
}

/** 终态白名单之外全部保守阻止结案 不把失败和未知结果算作完成 */
const TERMINAL_STATES: Record<ClosureResourceType, readonly string[]> = {
  refund: ['succeeded', 'cancelled'],
  compensation: ['succeeded', 'rejected', 'expired', 'cancelled'],
  price_protection: ['succeeded', 'rejected', 'expired', 'cancelled'],
  return_request: ['completed', 'rejected', 'expired', 'cancelled'],
  approval: ['approved', 'rejected', 'expired'],
  // 恢复调用失败可以由人工处理 但对应业务单仍须独立满足终态要求
  execution: ['completed', 'failed'],
  evidence: [],
  task: ['completed', 'cancelled', 'call_failed', 'business_failed'],
  payment_effect: ['succeeded', 'rejected'],
}

const LABELS: Record<ClosureResourceType, string> = {
  refund: '退款',
  compensation: '补偿',
  price_protection: '价保',
  return_request: '售后单',
  approval: '审批',
  execution: '审批执行',
  evidence: '案件依据',
  task: '持久任务',
  payment_effect: '渠道资金意图',
}

export function closureBlockers(resources: ClosureResource[]): ClosureBlocker[] {
  return resources
    .filter((resource) => !TERMINAL_STATES[resource.resourceType].includes(resource.status))
    .map((resource) => ({
      ...resource,
      reason:
        resource.status === 'missing' || resource.status === 'unverified'
          ? `${LABELS[resource.resourceType]}记录缺失或归属无法核实`
          : `${LABELS[resource.resourceType]}尚未确认结束 当前状态 ${resource.status}`,
    }))
}

/** 实现层必须在同一事务内重新核验并写入状态 客户事件与内部审计 */
export interface CaseClosureRepository {
  review(runId: string): Promise<CaseClosureReview>
  resolve(input: {
    runId: string
    summary: string
    actor: Actor
    now: string
  }): Promise<{ resolved: boolean; review: CaseClosureReview }>
}
