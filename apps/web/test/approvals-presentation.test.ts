import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/lib/api'
import {
  approvalError,
  approvalState,
  resourceName,
  executionState,
  executionOutcome,
} from '../src/components/approvals/presentation'
import type { ApprovalRequest } from '../src/lib/types'

const approval: ApprovalRequest = {
  approvalId: 'apr_test',
  runId: 'run_test',
  resourceType: 'compensation',
  resourceId: 'cmp_test',
  reason: '金额超过自动处理范围',
  amountCents: 12500,
  status: 'pending',
  expiresAt: '2026-09-25T08:00:00.000Z',
  createdAt: '2026-09-25T07:00:00.000Z',
}

describe('审批展示边界', () => {
  it('恢复调用结束不等于业务成功且未知状态保守显示', () => {
    expect(executionState('completed')).toBe('调用已结束')
    expect(executionOutcome('unknown')).toMatchObject({ label: '结果未知', warning: true })
    expect(executionOutcome('waiting_return').label).toBe('等待退货处理')
    expect(executionOutcome('closed').label).toBe('业务已终止')
  })
  it('有效期到点即禁止继续作为待审批显示', () => {
    expect(approvalState(approval, Date.parse('2026-09-25T07:59:59.999Z'))).toBe('pending')
    expect(approvalState(approval, Date.parse(approval.expiresAt))).toBe('expired')
  })

  it('保留已决定状态并显示真实资源类型', () => {
    expect(approvalState({ ...approval, status: 'approved' }, Date.now())).toBe('approved')
    expect(resourceName('compensation')).toBe('补偿单')
    expect(resourceName('unknown_resource')).toBe('unknown_resource')
  })

  it('区分过期 冲突 权限失败与网络失败', () => {
    expect(approvalError(new ApiError(409, 'APPROVAL_EXPIRED', '审批已过期'))).toMatchObject({
      title: '审批已过期',
      refresh: true,
    })
    expect(approvalError(new ApiError(409, 'CONFLICT', '该审批已处理过'))).toMatchObject({
      title: '审批状态已变化',
      refresh: true,
    })
    expect(
      approvalError(new ApiError(403, 'AUTHORIZATION_DENIED', '审批决定仅限主管')),
    ).toMatchObject({ title: '没有决定权限', refresh: false })
    expect(approvalError(new TypeError('Failed to fetch'))).toMatchObject({
      title: '提交失败',
      refresh: false,
    })
  })
})
