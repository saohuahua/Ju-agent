import type { ApprovalExecutionView } from '@aftersales/contracts'

export interface ApprovalBusinessEvidence {
  linked: number
  resourceType: string | null
  businessStatus: string | null
  refundStatus: string | null
  returnType: string | null
  refundAmount: number | null
}

/** 只有归属可信且业务记录一致才报告成功 缺失与矛盾记录保留未知 */
export function approvalBusinessOutcome(
  row: ApprovalBusinessEvidence,
): ApprovalExecutionView['outcome'] {
  if (!row.linked || !row.businessStatus) return 'unknown'
  const status = row.businessStatus
  const closed = ['rejected', 'expired', 'cancelled']
  if (row.resourceType === 'return_request' && row.returnType !== 'exchange') {
    if (closed.includes(status)) {
      return row.refundStatus === 'cancelled' || !row.refundStatus ? 'closed' : 'unknown'
    }
    if ((row.refundAmount ?? 0) > 0 && !row.refundStatus) return 'unknown'
    if (row.refundStatus === 'failed') return 'failed'
    if (row.refundStatus === 'executing') return 'running'
    if (status === 'completed') return row.refundStatus === 'succeeded' ? 'succeeded' : 'unknown'
    if (row.refundStatus && !['created', 'succeeded'].includes(row.refundStatus)) return 'unknown'
  }
  if (closed.includes(status)) return 'closed'
  if (status === 'failed') return 'failed'
  if (status === 'executing') return 'running'
  if (['awaiting_buyer_shipment', 'buyer_shipped', 'goods_received'].includes(status))
    return 'waiting_return'
  if (row.resourceType === 'return_request' && status === 'completed') return 'succeeded'
  if (row.resourceType !== 'return_request' && status === 'succeeded') return 'succeeded'
  if (['submitted', 'created', 'auto_approved', 'awaiting_approval', 'approved'].includes(status))
    return 'pending'
  return 'unknown'
}
