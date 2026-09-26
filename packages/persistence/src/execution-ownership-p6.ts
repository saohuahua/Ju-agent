import type {
  P6CommandInput,
  P6Payment,
  P6PaymentResult,
  P6Task,
} from '../../contracts/src/p6-durable.js'
import type { SqliteDatabase } from './db.js'
import { ExecutionOwnershipRepository } from './execution-ownership-repository.js'
import { P6TaskRepository } from './p6-task-repository.js'
import { p6ApplyBusinessPayment, p6PrepareBusinessPayment } from './p6-business-adapter.js'
import { assertConversationRefundPayment } from './p6-conversation-refund.js'

/**
 * 可信内部入口只负责互斥 不创建业务资格或审批映射
 * 已受理命令重放仍验证原请求 同业务键的新命令不能换运行绕过
 */
export function acceptExecutionOwnedCommand(db: SqliteDatabase, input: P6CommandInput): P6Task {
  return db
    .transaction(() => {
      const tasks = new P6TaskRepository(db)
      const ownership = new ExecutionOwnershipRepository(db)
      const key = input.plan.payment?.businessKey
      if (!key) return tasks.accept(input)
      const existing = tasks.findRequest(input.customerId, input.requestKey)
      if (existing) {
        const record = ownership.get(key)
        if (
          record?.owner !== 'p6' ||
          record.holder !== existing.commandId ||
          existing.input.plan.payment?.businessKey !== key
        ) {
          throw new Error('既有命令没有匹配的资金执行权')
        }
        return tasks.accept(input)
      }
      return ownership.takeoverWithCommand(key, () => tasks.accept(input))
    })
    .immediate()
}

/** 作为发送前同步回调接入 许可与原资金意图在同一个围栏事务提交 */
export function executionOwnershipPreparePayment(
  db: SqliteDatabase,
  payment: P6Payment,
  task: P6Task,
): void {
  const ownership = new ExecutionOwnershipRepository(db)
  assertConversationRefundPayment(db, payment, task)
  ownership.acquireP6(payment.businessKey, task.commandId)
  p6PrepareBusinessPayment(db, payment, task)
}

/**
 * 作为终态同步回调接入 原业务结果与执行权终态共同提交
 * 未知结果不会进入此回调 发送许可持续保留 恢复只能查询原交易
 */
export function executionOwnershipApplyPayment(
  db: SqliteDatabase,
  payment: P6Payment,
  result: P6PaymentResult,
): void {
  if (!db.inTransaction) throw new Error('资金结果必须在围栏事务内提交')
  const ownership = new ExecutionOwnershipRepository(db)
  const record = ownership.get(payment.businessKey)
  const effect = db
    .prepare(
      `SELECT t.command_id AS commandId FROM p6_effects e
    JOIN p6_tasks t ON t.task_id = e.task_id WHERE e.business_key = ?`,
    )
    .get(payment.businessKey) as { commandId: string } | undefined
  if (!record?.token || record.owner !== 'p6' || record.holder !== effect?.commandId) {
    throw new Error('资金结果没有匹配的发送许可')
  }
  const permit = {
    businessKey: payment.businessKey,
    owner: 'p6' as const,
    holder: record.holder,
    token: record.token,
  }
  if (result.status !== 'succeeded' && result.status !== 'rejected') {
    throw new Error('未知结果不能终结资金执行权')
  }
  p6ApplyBusinessPayment(db, payment, result)
  if (result.status === 'succeeded') ownership.succeed(permit, result)
  else ownership.reject(permit, result)
}
