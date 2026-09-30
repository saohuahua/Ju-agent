import type { ApprovalExecutionView } from '@aftersales/contracts'
import { approvalBusinessOutcome } from '@aftersales/domain'
import type { SqliteDatabase } from './db.js'

type ProgressRow = Omit<ApprovalExecutionView, 'outcome'> & {
  linked: number
  returnType: string | null
  refundAmount: number | null
}

/** 审批执行列表批量关联实际业务单 不读取令牌 参数或原始异常 */
export class SqliteApprovalProgressRepository {
  constructor(private readonly db: SqliteDatabase) {}

  list(): ApprovalExecutionView[] {
    const rows = this.db
      .prepare(
        `
      SELECT e.approval_id AS approvalId, e.run_id AS runId, e.decision,
        e.decided_by AS decidedBy, e.status,
        CASE WHEN e.last_error IS NULL THEN NULL ELSE '恢复调用失败 请查看关联会话并核验业务记录' END AS lastError,
        e.created_at AS createdAt, e.updated_at AS updatedAt,
        a.resource_type AS resourceType, a.resource_id AS resourceId, a.amount_cents AS amountCents,
        COALESCE(r.status, c.status, p.status) AS businessStatus,
        f.status AS refundStatus, r.type AS returnType, r.refund_amount_cents AS refundAmount,
        t.status AS taskStatus,
        CASE WHEN a.run_id = e.run_id AND g.customer_id = COALESCE(r.customer_id, c.customer_id, p.customer_id)
          THEN 1 ELSE 0 END AS linked
      FROM approval_execution_intents e
      LEFT JOIN approval_requests a ON a.approval_id = e.approval_id
      LEFT JOIN agent_runs g ON g.run_id = e.run_id
      LEFT JOIN p6_tasks t ON t.task_id = (
        SELECT candidate.task_id FROM p6_tasks candidate
        JOIN p6_commands command ON command.command_id = candidate.command_id
        WHERE candidate.run_id = e.run_id AND
          (candidate.approval_id = e.approval_id OR
            (json_extract(command.input_json, '$.requestPayload.approvalId') = e.approval_id
             AND json_extract(command.input_json, '$.requestPayload.action') = 'receive_goods'))
        ORDER BY CASE WHEN candidate.approval_id IS NULL THEN 0 ELSE 1 END LIMIT 1
      )
      LEFT JOIN return_requests r ON a.resource_type = 'return_request' AND r.return_no = a.resource_id
      LEFT JOIN refunds f ON f.return_no = r.return_no
      LEFT JOIN compensations c ON a.resource_type = 'compensation' AND c.compensation_no = a.resource_id
      LEFT JOIN price_protections p ON a.resource_type = 'price_protection' AND p.protection_no = a.resource_id
      ORDER BY e.created_at DESC, e.approval_id DESC LIMIT 100
    `,
      )
      .all() as ProgressRow[]

    return rows.map((row) => ({
      approvalId: row.approvalId,
      runId: row.runId,
      decision: row.decision,
      decidedBy: row.decidedBy,
      status: row.status,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      amountCents: row.amountCents,
      businessStatus: row.linked ? row.businessStatus : null,
      refundStatus: row.linked ? row.refundStatus : null,
      taskStatus: row.taskStatus,
      // 本地单据不能覆盖渠道结果未知的恢复状态
      outcome: row.taskStatus === 'needs_confirmation' ? 'unknown' : approvalBusinessOutcome(row),
    }))
  }
}
