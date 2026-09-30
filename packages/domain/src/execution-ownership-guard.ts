import type {
  ExecutionPermit,
  LegacyExecutionOwnership,
} from '../../contracts/src/execution-ownership-contract.js'

/**
 * 未注入时只兼容旧装配 不具备新旧执行互斥防线
 * 许可先落库再推进业务和调用渠道 取得后禁止因超时释放
 */
export class LegacyExecutionGuard {
  private readonly permit: ExecutionPermit | undefined
  private confirmed = false

  constructor(
    private readonly ownership: LegacyExecutionOwnership | undefined,
    key: string,
  ) {
    this.permit = ownership?.acquireLegacy(key)
  }

  /** 渠道已确认成功后即使本地记账失败也不得降级为可重试失败 */
  succeeded(result: unknown): void {
    this.confirmed = true
    if (this.permit) this.ownership!.succeed(this.permit, result)
  }

  /** 崩溃空窗与异常都不能证明未支付 未知只允许核验原交易 */
  failed(): boolean {
    if (this.confirmed) return false
    if (this.permit) this.ownership!.unknown(this.permit)
    return true
  }
}
