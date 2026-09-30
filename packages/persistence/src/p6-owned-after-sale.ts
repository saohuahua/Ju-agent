import { receiveGoodsIdempotencyKey } from '@aftersales/contracts'
import type { P6ConfigSnapshot, P6Task } from '../../contracts/src/p6-durable.js'
import type { P6AfterSaleReceipt } from '../../contracts/src/p6-after-sale-mapping.js'
import type { SqliteDatabase } from './db.js'
import { P6AfterSaleRepository, type P6AfterSaleGuard } from './p6-after-sale-repository.js'
import { ExecutionOwnershipRepository } from './execution-ownership-repository.js'
import { P6TaskRepository } from './p6-task-repository.js'

/** 等待阶段即接管原退款 收货只能在验证原授权后转绑尚未发送的许可 */
export class P6OwnedAfterSale {
  constructor(private readonly db: SqliteDatabase) {}

  /** 只终止未接管且从未发送的审批 历史未知和已消费授权不能按过期释放 */
  expireApproval(approvalId: string): void {
    const key = this.key(approvalId)
    const guard: P6AfterSaleGuard = (db, context) => {
      if (db !== this.db || !db.inTransaction || context.phase !== 'expiry')
        throw new Error('过期终止必须在同库事务')
      if (key) {
        const record = new ExecutionOwnershipRepository(db).get(key)
        if (
          context.businessKey !== key ||
          record?.owner !== 'legacy' ||
          record.state !== 'ready' ||
          record.holder ||
          record.token
        )
          throw new Error('未知或已接管退款不能按过期终止')
      }
    }
    new P6AfterSaleRepository(this.db, guard).expireApproval(approvalId)
  }

  private key(approvalId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT r.type, r.return_no AS returnNo
      FROM approval_requests a JOIN return_requests r ON r.return_no = a.resource_id
      WHERE a.approval_id = ? AND a.resource_type = 'return_request'`,
      )
      .get(approvalId) as { type: string; returnNo: string } | undefined
    if (!row) throw new Error('售后审批不存在')
    return row.type === 'exchange' ? undefined : `refund:${row.returnNo}`
  }

  acceptApproval(approvalId: string, config: P6ConfigSnapshot): P6Task {
    return this.db
      .transaction(() => {
        const key = this.key(approvalId)
        const ownership = new ExecutionOwnershipRepository(this.db)
        const original = this.db
          .prepare('SELECT task_id AS taskId FROM p6_tasks WHERE approval_id = ?')
          .get(approvalId) as { taskId: string } | undefined
        const guard: P6AfterSaleGuard = (db, context) => {
          if (db !== this.db || !db.inTransaction || context.phase !== 'approval')
            throw new Error('售后接管必须与审批受理同事务')
          if (key) {
            const record = ownership.get(key)
            if (
              context.businessKey !== key ||
              record?.owner !== 'p6' ||
              record.state !== 'ready' ||
              record.holder
            )
              throw new Error('等待阶段缺少原退款执行权')
          }
        }
        const sales = new P6AfterSaleRepository(this.db, guard)
        if (original) {
          const task = sales.acceptApproval(approvalId, config)
          if (key) {
            const record = ownership.get(key)
            const receipt = new P6TaskRepository(this.db).findRequest(
              task.customerId,
              receiveGoodsIdempotencyKey(String(task.input.requestPayload?.returnNo)),
            )
            if (
              record?.owner !== 'p6' ||
              (record.holder !== task.commandId && record.holder !== receipt?.commandId)
            )
              throw new Error('既有审批执行权不匹配')
          }
          return task
        }
        return key
          ? ownership.takeoverWithCommand(key, () => sales.acceptApproval(approvalId, config))
          : sales.acceptApproval(approvalId, config)
      })
      .immediate()
  }

  receive(input: P6AfterSaleReceipt): P6Task {
    return this.db
      .transaction(() => {
        const key = this.key(input.approvalId)
        const tasks = new P6TaskRepository(this.db)
        const original = tasks.findRequest(input.customerId, `approval:${input.approvalId}`)
        if (!original) throw new Error('收货缺少持久审批授权')
        const ownership = new ExecutionOwnershipRepository(this.db)
        const guard: P6AfterSaleGuard = (db, context) => {
          if (db !== this.db || !db.inTransaction || context.phase !== 'receipt')
            throw new Error('收货必须与授权转绑同事务')
          if (key) {
            const record = ownership.get(key)
            if (
              context.businessKey !== key ||
              record?.owner !== 'p6' ||
              record.state !== 'ready' ||
              record.holder !== original.commandId ||
              record.token
            )
              throw new Error('收货不能转绑已发送或未知许可')
          }
        }
        // 原映射先验证归属 金额 收货前置和持久审批 后续失败仍回滚全部写入
        const task = new P6AfterSaleRepository(this.db, guard).receive(input)
        if (key) {
          const record = ownership.get(key)
          if (record?.owner === 'p6' && record.holder === task.commandId) return task
          const changed = this.db
            .prepare(
              `UPDATE execution_ownership SET holder = ?
          WHERE business_key = ? AND owner = 'p6' AND holder = ? AND state = 'ready' AND token IS NULL`,
            )
            .run(task.commandId, key, original.commandId).changes
          if (changed !== 1) throw new Error('收货执行权转绑冲突')
        }
        return task
      })
      .immediate()
  }
}
