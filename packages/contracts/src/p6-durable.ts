/**
 * 持久调度只接收上游冻结的配置引用和快照
 * 配置内容由模型网关解释 此处不读取全局配置或保存密钥
 */
export interface P6ConfigSnapshot {
  snapshotId: string
  provider: string
  model: string
  promptVersion: string
  value: Readonly<Record<string, unknown>>
}

export interface P6Payment {
  businessKey: string
  amountCents: number
  currency: string
  resourceId: string
}

/** 业务层须先完成身份归属金额与审批校验 再把不可变计划交给调度 */
export interface P6Plan {
  input: string
  payment?: P6Payment
  tool: string
}

export interface P6CommandInput {
  requestKey: string
  customerId: string
  kind: 'start' | 'approval' | 'message'
  plan: P6Plan
  config: P6ConfigSnapshot
  runId?: string
  approvalId?: string
  source?: 'customer' | 'sim'
  /** 原始已验证请求用于网络重试判同 不包含服务端重新选择的配置 */
  requestPayload?: Readonly<Record<string, unknown>>
}

export type P6Status =
  | 'queued'
  | 'running'
  | 'completed'
  | 'call_failed'
  | 'business_failed'
  | 'needs_confirmation'
  | 'cancelled'

export interface P6Claim {
  taskId: string
  owner: string
  generation: number
}

export interface P6Task extends P6Claim {
  runId: string
  commandId: string
  status: P6Status
  customerId: string
  provider: string
  tool: string
  leaseUntil: number
  attempt: number
  cancelRequested: number
  deadline: number
  input: P6CommandInput
  approvalId: string | null
  error: string | null
}

export type P6PaymentResult =
  | { status: 'succeeded'; transactionId: string }
  | { status: 'rejected'; reason: string }
  | { status: 'unknown'; reason: string }
  | { status: 'not_found' }

/** 查询失败与没有查到均不能证明一个已经发送的资金动作尚未发生 */
export interface P6PaymentPort {
  execute(payment: P6Payment, signal: AbortSignal): Promise<P6PaymentResult>
  query(businessKey: string, signal: AbortSignal): Promise<P6PaymentResult>
}

export interface P6Limits {
  global: number
  customer: number
  provider: number
  tool: number
}
