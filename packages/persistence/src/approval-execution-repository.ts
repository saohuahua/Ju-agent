import type { SqliteDatabase } from './db.js'

export interface ApprovalExecutionIntent {
  approvalId: string
  runId: string
  decision: 'approved' | 'rejected'
  decidedBy: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  lastError: string | null
  createdAt: string
  updatedAt: string
}

const COLUMNS = `approval_id AS approvalId, run_id AS runId, decision, decided_by AS decidedBy,
  status, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt`

/**
 * 审批执行意图由审批决定事务写入 此仓储只负责认领和结果记录
 * 当前不自动重领运行中的任务 进程退出后的未知副作用留待恢复层核验
 */
export class SqliteApprovalExecutionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  find(approvalId: string): ApprovalExecutionIntent | undefined {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM approval_execution_intents WHERE approval_id = ?`)
      .get(approvalId) as ApprovalExecutionIntent | undefined
  }

  list(): ApprovalExecutionIntent[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM approval_execution_intents ORDER BY created_at DESC, approval_id DESC LIMIT 100`,
      )
      .all() as ApprovalExecutionIntent[]
  }

  claim(approvalId: string, now: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE approval_execution_intents SET status = 'running', updated_at = ?
      WHERE approval_id = ? AND status = 'pending'`,
        )
        .run(now, approvalId).changes === 1
    )
  }

  finish(
    approvalId: string,
    status: 'completed' | 'failed',
    now: string,
    error: string | null = null,
  ): void {
    const result = this.db
      .prepare(
        `UPDATE approval_execution_intents SET status = ?, last_error = ?, updated_at = ?
      WHERE approval_id = ? AND status = 'running'`,
      )
      .run(status, error, now, approvalId)
    if (result.changes !== 1) throw new Error('审批执行意图状态冲突')
  }
}
