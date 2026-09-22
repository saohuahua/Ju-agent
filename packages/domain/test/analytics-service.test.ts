/**
 * 运营分析服务口径测试
 *
 * 覆盖 source 口径过滤 解决率与升级率推导 CSAT 均值与交叉
 * 读模型用内存桩 SQL 实现的口径由 API 契约测试覆盖
 */

import { describe, expect, it } from 'vitest'
import { AnalyticsService } from '../src/services/analytics-service.js'
import type { AnalyticsReadModel } from '../src/repositories.js'

function stubReadModel(overrides: Partial<AnalyticsReadModel> = {}): AnalyticsReadModel {
  return {
    runStatusCounts: async (source) =>
      source === 'customer'
        ? [
            { status: 'completed', count: 6 },
            { status: 'escalated', count: 2 },
            { status: 'failed', count: 2 },
          ]
        : [{ status: 'completed', count: 99 }],
    runsByDay: async (source, days) =>
      source === 'customer'
        ? [
            { day: '2026-09-21', count: 3 },
            { day: '2026-09-22', count: 7 },
          ]
        : [],
    avgTurns: async (source) => (source === 'customer' ? 4.5 : 0),
    escalatedRunCount: async (source) => (source === 'customer' ? 3 : 0),
    toolDistribution: async (source) =>
      source === 'customer'
        ? [
            { toolName: 'get_order', total: 20, failed: 2 },
            { toolName: 'submit_return_request', total: 6, failed: 0 },
          ]
        : [],
    avgApprovalLatencyMs: async () => 120_000,
    decidedApprovalCount: async () => 4,
    ratingCounts: async () => [
      { score: 1, count: 1 },
      { score: 5, count: 3 },
    ],
    ratingCount: async () => 4,
    ratingByFinalStatus: async () => [
      { status: 'completed', avgScore: 4.5, count: 2 },
      { status: 'escalated', avgScore: 2, count: 1 },
      { status: 'handling_human', avgScore: 4, count: 1 },
    ],
    ...overrides,
  }
}

describe('运营分析口径', () => {
  it('总览只聚合 customer 口径 派生比率正确', async () => {
    const service = new AnalyticsService(stubReadModel())
    const overview = await service.overview(14)
    expect(overview.totalSessions).toBe(10)
    expect(overview.resolutionRate).toBe(0.6)
    expect(overview.escalationRate).toBe(0.3)
    expect(overview.avgTurns).toBe(4.5)
    expect(overview.decidedApprovalCount).toBe(4)
    expect(overview.avgApprovalLatencyMs).toBe(120_000)
  })

  it('CSAT 均值按分值加权 交叉表按终态分组', async () => {
    const service = new AnalyticsService(stubReadModel())
    const overview = await service.overview(14)
    expect(overview.ratingCount).toBe(4)
    expect(overview.avgRating).toBe(4)
    const cross = overview.ratingByFinalStatus
    expect(cross.find((entry) => entry.status === 'completed')?.avgScore).toBe(4.5)
    expect(cross.find((entry) => entry.status === 'escalated')?.count).toBe(1)
  })

  it('零会话时比率归零 CSAT 为空 不除零', async () => {
    const service = new AnalyticsService(
      stubReadModel({
        runStatusCounts: async () => [],
        escalatedRunCount: async () => 0,
        ratingCounts: async () => [],
        ratingCount: async () => 0,
        ratingByFinalStatus: async () => [],
        avgApprovalLatencyMs: async () => null,
      }),
    )
    const overview = await service.overview(14)
    expect(overview.totalSessions).toBe(0)
    expect(overview.resolutionRate).toBe(0)
    expect(overview.escalationRate).toBe(0)
    expect(overview.avgRating).toBeNull()
    expect(overview.avgApprovalLatencyMs).toBeNull()
  })
})
