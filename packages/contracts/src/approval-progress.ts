import { z } from 'zod'

/** 调用状态与业务结果独立传输 禁止把调用结束解释为付款成功 */
export const ApprovalExecutionView = z.object({
  approvalId: z.string(),
  runId: z.string(),
  decision: z.enum(['approved', 'rejected']),
  decidedBy: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  amountCents: z.number().int().nullable(),
  businessStatus: z.string().nullable(),
  refundStatus: z.string().nullable(),
  taskStatus: z
    .enum([
      'queued',
      'running',
      'completed',
      'call_failed',
      'business_failed',
      'needs_confirmation',
      'cancelled',
    ])
    .nullable(),
  outcome: z.enum([
    'pending',
    'running',
    'waiting_return',
    'succeeded',
    'failed',
    'closed',
    'unknown',
  ]),
})

export type ApprovalExecutionView = z.infer<typeof ApprovalExecutionView>

export const ApprovalExecutionsResponse = z.object({
  executions: z.array(ApprovalExecutionView),
  limit: z.number().int(),
})
