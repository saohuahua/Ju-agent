import type { P7Snapshot } from './p7-model-gateway.js'
import { z } from 'zod'

export const P8AnalysisReply = z
  .object({
    facts: z.array(z.object({ key: z.string(), value: z.string(), ref: z.string() }).strict()),
    citations: z.array(z.string()),
    unresolved: z.array(z.string()),
  })
  .strict()

export type P8Role = 'facts' | 'policy'
export type P8Mode = 'single' | 'parallel'
export type P8Recommendation = 'controlled_review' | 'ask_user' | 'human_review'

/** 原文与确定性字段保留来源 模型只能引用不能替换 */
export interface P8Evidence {
  ref: string
  customerId: string
  orderNo: string
  kind: 'order' | 'shipment' | 'policy'
  version: string
  data: Record<string, unknown>
}

export interface P8Fact {
  key: string
  value: string
  ref: string
}

/** 字段验证只做确定性投影 不代表模型推理成绩 */
export function p8FactsFromEvidence(evidence: P8Evidence[]): P8Fact[] {
  return evidence.map((item) => ({
    key: item.kind === 'policy' ? `policy.${String(item.data.articleId)}` : `${item.kind}.status`,
    value: String(item.kind === 'policy' ? item.data.content : item.data.status),
    ref: item.ref,
  }))
}

export interface P8BusinessReference {
  kind: 'approval' | 'refund' | 'return' | 'compensation' | 'price_protection'
  id: string
  status: string
  /** 可选资金证据兼容旧快照 不携带发送令牌或审批凭据 */
  execution?: {
    businessKey: string
    effectStatus: string | null
    owner: string | null
    ownershipState: string | null
    taskId: string | null
    taskStatus: string | null
    bindingValid: boolean
  }
}

/** 身份在受理时冻结 repeat 仅代表预先安排的实验轮次 */
export interface P8Input {
  experimentId: string
  caseId: string
  repeat: number
  mode: P8Mode
  customerId: string
  orderNo: string
  userStatements: string[]
  policyVersion: string
  knowledgeVersion: string
  snapshot: P7Snapshot
  evidence: P8Evidence[]
  businessReferences: P8BusinessReference[]
  acceptedAt: number
}

export interface P8BranchResult {
  parentRunId: string
  taskId: string
  runId: string
  customerId: string
  orderNo: string
  role: P8Role
  status: 'confirmed' | 'failed' | 'timeout' | 'cancelled'
  facts: P8Fact[]
  citations: string[]
  unresolved: string[]
  error: string | null
  configVersion: string
  knowledgeVersion: string
  startedAt: number | null
  finishedAt: number | null
}

/** 便签是持久事实的投影 不承担授权职责 */
export interface P8Memory {
  parentRunId: string
  customerId: string
  orderNo: string
  userStatements: string[]
  evidenceRefs: string[]
  confirmedFacts: P8Fact[]
  unresolved: string[]
  waitingReasons: string[]
  branches: Array<{ taskId: string; role: P8Role; status: string }>
  businessReferences: P8BusinessReference[]
  completedActions: P8BusinessReference[]
  unknownActions: P8BusinessReference[]
}

export interface P8Conclusion {
  status: 'complete' | 'incomplete'
  recommendation: P8Recommendation
  reasons: string[]
  memory: P8Memory
  finishedAt: number
}
