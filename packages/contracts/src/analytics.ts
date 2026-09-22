/**
 * 运营分析契约
 *
 * 纯读侧聚合的响应形状 口径声明 source=customer 是唯一口径
 * 评测与模拟会话不进运营指标 满意度与任务成功分开表述
 */

import { z } from 'zod'

export const AnalyticsOverviewResponse = z.object({
  /** 真实客户会话总量 */
  totalSessions: z.number().int().nonnegative(),
  statusCounts: z.array(z.object({ status: z.string(), count: z.number().int().nonnegative() })),
  resolutionRate: z.number().min(0).max(1),
  escalationRate: z.number().min(0).max(1),
  sessionsByDay: z.array(z.object({ day: z.string(), count: z.number().int().nonnegative() })),
  avgTurns: z.number().nonnegative(),
  toolDistribution: z.array(
    z.object({
      toolName: z.string(),
      total: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
  ),
  avgApprovalLatencyMs: z.number().nullable(),
  decidedApprovalCount: z.number().int().nonnegative(),
  ratingCounts: z.array(
    z.object({ score: z.number().int(), count: z.number().int().nonnegative() }),
  ),
  ratingCount: z.number().int().nonnegative(),
  avgRating: z.number().nullable(),
  ratingByFinalStatus: z.array(
    z.object({ status: z.string(), avgScore: z.number(), count: z.number().int().nonnegative() }),
  ),
  /** 聚合窗口天数 */
  days: z.number().int().positive(),
  /** 口径声明 如实告知聚合范围 */
  scopeNote: z.string(),
})
export type AnalyticsOverviewResponse = z.infer<typeof AnalyticsOverviewResponse>
