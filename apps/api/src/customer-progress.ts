import type { CustomerRefundProgress } from '@aftersales/contracts'
import type { SqliteDatabase } from '@aftersales/persistence'
import { P6ConversationRefundRepository } from '../../../packages/persistence/src/p6-conversation-refund.js'
import type { AgentRunRecord } from '@aftersales/domain'

/** 只读原会话业务事实 保留客户白名单边界 */
export function customerRefundProgress(
  db: SqliteDatabase,
  run: AgentRunRecord,
  now: Date,
): CustomerRefundProgress | null {
  // 同一读取事务核对关联与状态 避免拼接多个时点的页面进度
  return db.transaction(() => {
    const current = db
      .prepare('SELECT status, customer_id FROM agent_runs WHERE run_id = ?')
      .get(run.runId) as { status: string; customer_id: string } | undefined
    if (!current || current.customer_id !== run.customerId) throw new Error('客户会话关联校验失败')
    const repository = new P6ConversationRefundRepository(db)
    const link = repository.link(run.runId)
    // 没有原申请关联表示尚无退款进度 不表示失败也不表示成功
    if (!link) return null
    const { record, refund } = repository.validate(link)
    if (record.customerId !== run.customerId || !['return', 'refund_only'].includes(record.type))
      throw new Error('客户售后关联校验失败')
    const approval = link.approval_id
      ? (db
          .prepare(
            `SELECT status, expires_at FROM approval_requests
          WHERE approval_id = ? AND run_id = ? AND resource_id = ? AND resource_type = 'return_request'`,
          )
          .get(link.approval_id, run.runId, record.returnNo) as
          { status: string; expires_at: string } | undefined)
      : undefined
    const effect = refund
      ? (db
          .prepare('SELECT status FROM p6_effects WHERE business_key = ?')
          .get(refund.idempotencyKey) as { status: string } | undefined)
      : undefined
    const ownership = refund
      ? (db
          .prepare(
            'SELECT owner, state, token IS NOT NULL AND length(token) > 0 AS confirmed FROM execution_ownership WHERE business_key = ?',
          )
          .get(refund.idempotencyKey) as
          { owner: string; state: string; confirmed: number } | undefined)
      : undefined
    const tasks = db
      .prepare("SELECT status FROM p6_tasks WHERE run_id = ? AND tool != 'conversation'")
      .all(run.runId) as { status: string }[]
    const shipment = db
      .prepare(
        `SELECT json_extract(detail_json, '$.trackingNo') AS trackingNo
      FROM audit_logs WHERE run_id = ? AND resource_id = ? AND resource_type = 'return_request'
      AND action = 'return_shipment_recorded' AND actor_role = 'customer' AND actor_id = ?
      ORDER BY id LIMIT 1`,
      )
      .get(run.runId, record.returnNo, run.customerId) as { trackingNo: string | null } | undefined
    // 售后 退款 资金效果与发送许可必须共同确认成功
    const succeeded =
      record.status === 'completed' &&
      refund?.status === 'succeeded' &&
      effect?.status === 'succeeded' &&
      ownership?.owner === 'p6' &&
      ownership.state === 'succeeded' &&
      ownership.confirmed === 1
    // 部分成功或未确认发送都需要核验 不能只挑成功字段展示
    const uncertain =
      tasks.some((task) => task.status === 'needs_confirmation') ||
      (effect && !['succeeded', 'rejected'].includes(effect.status)) ||
      (ownership && ['sending', 'unknown'].includes(ownership.state)) ||
      (!succeeded &&
        (refund?.status === 'succeeded' ||
          record.status === 'completed' ||
          effect?.status === 'succeeded' ||
          ownership?.state === 'succeeded'))
    const expired =
      approval?.status === 'expired' ||
      (approval?.status === 'pending' && Date.parse(approval.expires_at) <= now.getTime()) ||
      record.status === 'expired'
    const approved = link.approval_id
      ? approval?.status === 'approved'
      : Boolean(link.authorization_task_id)
    let progress: CustomerRefundProgress['progress'] = 'processing'
    // 待核验优先于人工状态 防止转接沟通掩盖未知资金
    if (succeeded) progress = 'succeeded'
    else if (uncertain) progress = 'unknown'
    else if (expired) progress = 'expired'
    else if (record.status === 'rejected' || approval?.status === 'rejected') progress = 'rejected'
    else if (record.status === 'cancelled') progress = 'cancelled'
    else if (['handling_human', 'escalated', 'cancelled'].includes(current.status))
      progress = 'human'
    else if (
      record.status === 'failed' ||
      refund?.status === 'failed' ||
      effect?.status === 'rejected' ||
      tasks.some((task) => ['call_failed', 'business_failed', 'cancelled'].includes(task.status))
    )
      progress = 'failed'
    else if (link.approval_id && !approved) progress = 'awaiting_approval'
    else if (record.type === 'return' && approved && record.status === 'awaiting_buyer_shipment')
      progress = 'awaiting_shipment'
    else if (record.type === 'return' && record.status === 'buyer_shipped')
      progress = 'awaiting_receipt'
    return {
      runId: run.runId,
      returnNo: record.returnNo,
      orderNo: record.orderNo,
      type: record.type as 'return' | 'refund_only',
      progress,
      // 状态只是条件之一 原动作未投影且会话允许时才开放寄回
      canRegisterShipment:
        progress === 'awaiting_shipment' &&
        !link.projected &&
        ['awaiting_input', 'awaiting_approval'].includes(current.status),
      shipmentRegistered:
        Boolean(shipment) || ['buyer_shipped', 'goods_received'].includes(record.status),
      trackingNo: typeof shipment?.trackingNo === 'string' ? shipment.trackingNo : null,
    }
  })()
}
