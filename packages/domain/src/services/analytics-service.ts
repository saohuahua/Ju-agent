/**
 * 运营分析领域服务
 *
 * 纯读侧聚合 口径在领域层声明 SQL 实现留在持久层
 * source=customer 是唯一口径 评测与模拟会话不进运营指标
 * 任务成功与满意度的交叉由前端渲染 本层只提供数据
 */

import type { AnalyticsReadModel } from '../repositories.js'

export interface AnalyticsOverview {
  /** 真实客户会话总量 */
  totalSessions: number
  /** 终态分布 */
  statusCounts: Array<{ status: string; count: number }>
  /** 解决率 completed 占比 */
  resolutionRate: number
  /** 升级率 发生过 run.escalated 的会话占比 */
  escalationRate: number
  /** 按日会话量 最近 days 天 */
  sessionsByDay: Array<{ day: string; count: number }>
  /** 平均模型轮次 */
  avgTurns: number
  /** 工具调用分布 */
  toolDistribution: Array<{ toolName: string; total: number; failed: number }>
  /** 审批时效 毫秒 无已决审批为 null */
  avgApprovalLatencyMs: number | null
  decidedApprovalCount: number
  /** CSAT 分布 1 到 5 星 */
  ratingCounts: Array<{ score: number; count: number }>
  ratingCount: number
  /** CSAT 平均分 无评分为 null */
  avgRating: number | null
  /** CSAT 与终态交叉 满意度 vs AI 解决或人工解决 */
  ratingByFinalStatus: Array<{ status: string; avgScore: number; count: number }>
}

const STATUS_ORDER = [
  'completed',
  'escalated',
  'handling_human',
  'awaiting_input',
  'awaiting_approval',
  'running',
  'created',
  'failed',
  'cancelled',
]

export class AnalyticsService {
  constructor(private readonly readModel: AnalyticsReadModel) {}

  async overview(days = 14): Promise<AnalyticsOverview> {
    const [
      statusCounts,
      sessionsByDay,
      avgTurns,
      escalated,
      tools,
      approvalLatency,
      decided,
      ratingCounts,
      ratingTotal,
      ratingByStatus,
    ] = await Promise.all([
      this.readModel.runStatusCounts('customer'),
      this.readModel.runsByDay('customer', days),
      this.readModel.avgTurns('customer'),
      this.readModel.escalatedRunCount('customer'),
      this.readModel.toolDistribution('customer'),
      this.readModel.avgApprovalLatencyMs(),
      this.readModel.decidedApprovalCount(),
      this.readModel.ratingCounts(),
      this.readModel.ratingCount(),
      this.readModel.ratingByFinalStatus(),
    ])

    const total = statusCounts.reduce((sum, entry) => sum + entry.count, 0)
    const completed = statusCounts
      .filter((entry) => entry.status === 'completed')
      .reduce((sum, entry) => sum + entry.count, 0)
    const ordered = STATUS_ORDER.map((status) => {
      const found = statusCounts.find((entry) => entry.status === status)
      return { status, count: found?.count ?? 0 }
    }).filter(
      (entry) =>
        entry.count > 0 || ['completed', 'escalated', 'handling_human'].includes(entry.status),
    )

    const ratingCountSum = ratingCounts.reduce((sum, entry) => sum + entry.count, 0)
    const weighted = ratingCounts.reduce((sum, entry) => sum + entry.score * entry.count, 0)

    return {
      totalSessions: total,
      statusCounts: ordered,
      resolutionRate: total > 0 ? completed / total : 0,
      escalationRate: total > 0 ? escalated / total : 0,
      sessionsByDay,
      avgTurns,
      toolDistribution: tools,
      avgApprovalLatencyMs: approvalLatency,
      decidedApprovalCount: decided,
      ratingCounts,
      ratingCount: ratingTotal,
      avgRating: ratingCountSum > 0 ? weighted / ratingCountSum : null,
      ratingByFinalStatus: ratingByStatus,
    }
  }
}
