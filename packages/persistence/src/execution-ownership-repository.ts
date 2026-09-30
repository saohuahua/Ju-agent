import { randomUUID } from 'node:crypto'
import { createToolError } from '@aftersales/contracts'
import { DomainError } from '@aftersales/domain'
import type {
  ExecutionOwnershipRecord,
  ExecutionPermit,
  LegacyExecutionOwnership,
} from '../../contracts/src/execution-ownership-contract.js'
import type { SqliteDatabase } from './db.js'

function conflict(): never {
  throw new DomainError(createToolError('CONFLICT', '资金执行权冲突或结果待核验'))
}

/**
 * 所有权与发送状态独立保存 业务键唯一且不包含运行标识
 * 同步条件写与接管事务争用数据库写锁 不存在检查后发送的无锁窗口
 */
export class ExecutionOwnershipRepository implements LegacyExecutionOwnership {
  constructor(private readonly db: SqliteDatabase) {}

  /** 执行权跟随原资金业务键 查询本身不会重新授权 */
  get(businessKey: string): ExecutionOwnershipRecord | undefined {
    return this.db
      .prepare(
        `SELECT business_key AS businessKey, owner, holder, state,
      token, result_json AS resultJson FROM execution_ownership WHERE business_key = ?`,
      )
      .get(businessKey) as ExecutionOwnershipRecord | undefined
  }

  /** 只供刚创建业务的服务调用 登记中断留下缺失记录时默认拒绝执行 */
  registerNew(businessKey: string): void {
    if (!/^(refund|compensation|price_protection):.+$/.test(businessKey)) conflict()
    const changed = this.db
      .prepare(
        `INSERT OR IGNORE INTO execution_ownership
      VALUES (?, 'legacy', '', 'ready', NULL, NULL)`,
      )
      .run(businessKey).changes
    if (changed !== 1) conflict()
  }

  acquireLegacy(businessKey: string): ExecutionPermit {
    // 旧服务跨异步边界调用渠道 许可必须已经独立提交
    if (this.db.inTransaction) conflict()
    return this.acquire(businessKey, 'legacy', '')
  }

  /** 必须在持久任务发送前的围栏事务内与资金意图一起提交 */
  acquireP6(businessKey: string, commandId: string): ExecutionPermit {
    if (!this.db.inTransaction || !commandId) conflict()
    return this.acquire(businessKey, 'p6', commandId)
  }

  private acquire(businessKey: string, owner: 'legacy' | 'p6', holder: string): ExecutionPermit {
    // 新许可只在条件更新成功时有效 生成标识本身不代表获权
    const token = randomUUID()
    const changed = this.db
      .prepare(
        `UPDATE execution_ownership SET state = 'sending', token = ?
      WHERE business_key = ? AND owner = ? AND holder = ? AND state = 'ready'`,
      )
      .run(token, businessKey, owner, holder).changes
    // 零行表示已被占用或关联不符 不能继续发送网络请求
    if (changed !== 1) conflict()
    return { businessKey, owner, holder, token }
  }

  /**
   * 接管与命令受理使用同一连接的同步事务 任意失败同时回滚
   * 已取得发送许可或历史未知都禁止接管 成功记录只读
   */
  takeoverWithCommand<T extends { commandId: string }>(
    businessKey: string,
    accept: (db: SqliteDatabase) => T,
  ): T {
    return this.db
      .transaction(() => {
        const changed = this.db
          .prepare(
            `UPDATE execution_ownership SET owner = 'p6'
        WHERE business_key = ? AND owner = 'legacy' AND state = 'ready'`,
          )
          .run(businessKey).changes
        if (changed !== 1) conflict()
        // 许可接管与命令受理共用连接 保存命令失败会撤销接管
        const command = accept(this.db)
        // 同步事务不能等待异步回调 否则无法保证共同提交
        if (!command || 'then' in command || !command.commandId) {
          throw new Error('执行权受理必须同步返回命令标识')
        }
        this.db
          .prepare('UPDATE execution_ownership SET holder = ? WHERE business_key = ?')
          .run(command.commandId, businessKey)
        return command
      })
      .immediate()
  }

  /** 保存原许可的确认成功 终态继续阻止其他路径重新发送 */
  succeed(permit: ExecutionPermit, result: unknown): void {
    this.settle(permit, 'succeeded', JSON.stringify(result))
  }

  /** 普通异常与本地超时不能释放许可 未知状态保留原许可供迟到结果核验 */
  unknown(permit: ExecutionPermit): void {
    this.settle(permit, 'unknown', null)
  }

  /** 明确拒付仍保留业务键终态 不自动授权另一执行器重新发送 */
  reject(permit: ExecutionPermit, result: unknown): void {
    this.settle(permit, 'rejected', JSON.stringify(result))
  }

  /** 确认须匹配原持有者与许可 未知结果可沿原许可继续核验 */
  private settle(permit: ExecutionPermit, state: string, result: string | null): void {
    const changed = this.db
      .prepare(
        `UPDATE execution_ownership SET state = ?, result_json = ?
      WHERE business_key = ? AND owner = ? AND holder = ? AND token = ?
        AND state IN ('sending','unknown')`,
      )
      .run(state, result, permit.businessKey, permit.owner, permit.holder, permit.token).changes
    if (changed !== 1) conflict()
  }
}
