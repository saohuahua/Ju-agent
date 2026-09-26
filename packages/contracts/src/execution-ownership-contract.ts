/** 业务键沿用现有资金幂等键 不以运行标识分割执行权 */
export type ExecutionOwner = 'legacy' | 'p6' | 'unassigned'
export type ExecutionSendState = 'ready' | 'sending' | 'unknown' | 'succeeded' | 'rejected'

/** 许可没有租期 崩溃后仍保留原发送事实 */
export interface ExecutionPermit {
  businessKey: string
  owner: 'legacy' | 'p6'
  holder: string
  token: string
}

export interface ExecutionOwnershipRecord {
  businessKey: string
  owner: ExecutionOwner
  holder: string
  state: ExecutionSendState
  token: string | null
  resultJson: string | null
}

/** 仅新建业务登记可授予初始执行权 历史缺失记录必须拒绝 */
export interface LegacyExecutionOwnership {
  registerNew(businessKey: string): void
  acquireLegacy(businessKey: string): ExecutionPermit
  succeed(permit: ExecutionPermit, result: unknown): void
  unknown(permit: ExecutionPermit): void
}
