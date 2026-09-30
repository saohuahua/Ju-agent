import { ApiError } from '../../lib/api'
import type { ApprovalRequest, ApprovalExecutionView } from '../../lib/types'

/** 状态文案仅解释服务端事实 不从审批决定推断资金结果 */
export function executionState(status: ApprovalExecutionView['status']): string {
  return (
    { pending: '待执行', running: '执行中', completed: '调用已结束', failed: '调用失败' }[status] ??
    '调用状态未知'
  )
}

export function executionOutcome(outcome: ApprovalExecutionView['outcome']) {
  const states = {
    pending: {
      label: '待执行',
      description: '业务记录尚未完成 请等待处理或核查关联会话',
      warning: false,
    },
    running: { label: '执行中', description: '资金动作正在执行 最终结果尚未确认', warning: false },
    waiting_return: {
      label: '等待退货处理',
      description: '请继续寄回或收货流程 当前尚未完成业务',
      warning: false,
    },
    succeeded: { label: '执行成功', description: '关联业务记录已确认成功', warning: false },
    failed: {
      label: '执行失败',
      description: '关联业务记录为失败 请人工核验后续处理',
      warning: true,
    },
    closed: { label: '业务已终止', description: '关联业务已拒绝 过期或取消', warning: false },
    unknown: {
      label: '结果未知',
      description: '业务记录缺失或状态无法确认 请先核验 不要重复发起资金操作',
      warning: true,
    },
  }
  return states[outcome] ?? states.unknown
}

/** 持久任务待核验不能用原审批意图的运行中标签掩盖 */
export function durableTaskState(status: NonNullable<ApprovalExecutionView['taskStatus']>): string {
  return (
    {
      queued: '等待认领',
      running: '处理中',
      completed: '已完成',
      call_failed: '调用失败',
      business_failed: '业务失败',
      needs_confirmation: '待核验',
      cancelled: '已取消',
    }[status] ?? '任务状态未知'
  )
}

const RESOURCE_NAMES: Record<string, string> = {
  return_request: '售后单',
  compensation: '补偿单',
  price_protection: '价保单',
}

export function resourceName(type: string): string {
  return RESOURCE_NAMES[type] ?? type
}

export function approvalState(approval: ApprovalRequest, now: number): ApprovalRequest['status'] {
  const deadline = new Date(approval.expiresAt).getTime()
  if (approval.status === 'pending' && (!Number.isFinite(deadline) || deadline <= now))
    return 'expired'
  return approval.status
}

export function formatApprovalTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function approvalError(error: unknown): {
  title: string
  message: string
  refresh: boolean
} {
  if (error instanceof ApiError) {
    if (error.status === 403)
      return {
        title: '没有决定权限',
        message: '当前身份不能处理该审批 请切换到主管身份',
        refresh: false,
      }
    if (error.code === 'APPROVAL_EXPIRED')
      return { title: '审批已过期', message: '有效期已结束 请核对最新待办', refresh: true }
    if (error.status === 409)
      return {
        title: '审批状态已变化',
        message: error.message || '该审批已处理或关联会话已变化 请核对最新状态',
        refresh: true,
      }
    return { title: '提交失败', message: error.message, refresh: false }
  }

  return { title: '提交失败', message: '网络或服务暂时不可用 请核对待办后重试', refresh: false }
}
