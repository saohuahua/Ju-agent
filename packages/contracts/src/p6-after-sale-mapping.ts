/** 内部收货命令必须由已鉴权的仓储入口构造 不接收模型金额或客户端审批令牌 */
export interface P6AfterSaleReceipt {
  approvalId: string
  runId: string
  customerId: string
  returnNo: string
}

/** 守卫在当前同步事务内接管或核验原售后资源 具体执行权存储由集成方提供 */
export interface P6AfterSaleGuardContext extends P6AfterSaleReceipt {
  phase: 'approval' | 'receipt' | 'expiry'
  businessKey?: string
}
