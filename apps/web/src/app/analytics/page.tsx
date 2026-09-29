'use client'

/**
 * 运营分析仪表盘
 *
 * 真实客户会话的读侧聚合 口径 source=customer 评测与模拟会话不进指标
 * 图表自绘 单 sage 色系 遵循 dataviz 规范 满意度与任务成功分开表述
 * CSAT 与终态交叉 升级人工但满意 的样本是核心叙事
 */

import { ChartBar } from '@phosphor-icons/react'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Skeleton } from '@/components/Skeleton'
import {
  DayTrendColumns,
  HBarList,
  MetricTile,
  RatingColumns,
  RatioMeter,
} from '@/components/charts'
import { api } from '@/lib/api'
import { useIdentity } from '@/lib/identity'

const STATUS_LABEL: Record<string, string> = {
  completed: '已完成',
  escalated: '已升级人工',
  handling_human: '人工处理中',
  awaiting_input: '等待补充信息',
  awaiting_approval: '等待审批',
  running: '执行中',
  created: '已创建',
  failed: '失败',
  cancelled: '已取消',
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatLatency(ms: number | null): string {
  if (ms === null) return '-'
  const minutes = ms / 60000
  if (minutes >= 1) return `${minutes.toFixed(1)} 分钟`
  return `${Math.round(ms / 1000)} 秒`
}

const DAY_OPTIONS = [
  { value: 7, label: '近 7 天' },
  { value: 14, label: '近 14 天' },
  { value: 30, label: '近 30 天' },
]

export default function AnalyticsPage() {
  const [days, setDays] = useState(14)
  const { role } = useIdentity()
  const isStaff = role === 'operator' || role === 'supervisor'
  // 时间窗口进入查询键 迟到响应只能更新原窗口而不能覆盖当前选择
  const query = useQuery({
    queryKey: ['analytics', days],
    queryFn: () => api.getAnalytics(days),
    enabled: isStaff,
  })
  const overview = query.data
  const loading = query.isLoading
  const error = query.error?.message

  return (
    <>
      <div className="page-enter mx-auto max-w-5xl px-6 py-8">
        <header className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="rounded-control bg-sage-100 p-1.5 text-sage-700">
              <ChartBar size={20} weight="fill" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-base font-semibold tracking-tight">运营分析</h1>
              <p className="text-xs text-stone-500">
                真实客户会话的解决率 升级率 工具与满意度 满意度不参与任务成败判定
              </p>
            </div>
          </div>
          <div className="inline-flex rounded-control border border-hairline bg-surface p-0.5">
            {DAY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setDays(option.value)}
                className={`rounded-[6px] px-2.5 py-1 text-xs font-medium transition-colors duration-200 ${
                  days === option.value
                    ? 'bg-sage-100 text-sage-800'
                    : 'text-stone-500 hover:text-stone-700'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </header>

        {!isStaff && (
          <div className="mb-4 rounded-container border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
            当前身份是客户 请切换到 售后专员 或 主管 身份查看运营分析
          </div>
        )}

        {error && (
          <div className="rounded-container border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div
            className="grid grid-cols-2 gap-3 md:grid-cols-4"
            role="status"
            aria-label="正在读取运营统计"
          >
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-24 w-full" />
            ))}
          </div>
        ) : overview ? (
          <div className="space-y-6">
            {/* KPI 行 */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <MetricTile
                label="会话总量"
                value={String(overview.totalSessions)}
                sub={`仅真实客户 ${overview.days} 天窗口`}
              />
              <MetricTile
                label="解决率"
                value={percent(overview.resolutionRate)}
                sub="completed 占比"
                tone="sage"
              />
              <MetricTile
                label="升级率"
                value={percent(overview.escalationRate)}
                sub="发生过升级人工"
                tone="amber"
              />
              <MetricTile label="平均轮次" value={overview.avgTurns.toFixed(1)} sub="模型回合数" />
            </div>

            {/* 比例仪表 */}
            <section className="rounded-container border border-hairline bg-surface px-5 py-4">
              <div className="grid gap-6 md:grid-cols-2">
                <div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs font-medium text-stone-600">解决率</span>
                    <span className="text-sm font-semibold tabular-nums text-sage-700">
                      {percent(overview.resolutionRate)}
                    </span>
                  </div>
                  <div className="mt-2">
                    <RatioMeter value={overview.resolutionRate} tone="sage" />
                  </div>
                </div>
                <div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs font-medium text-stone-600">升级率</span>
                    <span className="text-sm font-semibold tabular-nums text-amber-700">
                      {percent(overview.escalationRate)}
                    </span>
                  </div>
                  <div className="mt-2">
                    <RatioMeter value={overview.escalationRate} tone="amber" />
                  </div>
                </div>
              </div>
            </section>

            {/* 趋势与分布 */}
            <div className="grid gap-4 md:grid-cols-2">
              <section className="rounded-container border border-hairline bg-surface px-5 py-4">
                <h2 className="text-sm font-medium text-stone-700">按日会话量</h2>
                {overview.sessionsByDay.length > 0 ? (
                  <div className="mt-3">
                    <DayTrendColumns data={overview.sessionsByDay} />
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-stone-400">{overview.days} 天内暂无客户会话</p>
                )}
              </section>

              <section className="rounded-container border border-hairline bg-surface px-5 py-4">
                <h2 className="text-sm font-medium text-stone-700">会话终态分布</h2>
                <div className="mt-3">
                  <HBarList
                    items={overview.statusCounts.map((entry) => ({
                      label: STATUS_LABEL[entry.status] ?? entry.status,
                      value: entry.count,
                    }))}
                  />
                </div>
              </section>
            </div>

            {/* 工具调用分布 */}
            <section className="rounded-container border border-hairline bg-surface px-5 py-4">
              <h2 className="text-sm font-medium text-stone-700">工具调用分布</h2>
              {overview.toolDistribution.length > 0 ? (
                <div className="mt-3">
                  <HBarList
                    items={overview.toolDistribution.map((entry) => ({
                      label: entry.toolName,
                      value: entry.total,
                      note: `${entry.toolName} 调用 ${entry.total} 次 失败 ${entry.failed} 次`,
                    }))}
                  />
                  <p className="mt-3 text-[11px] text-stone-400">
                    失败次数含故障注入与超时重试 悬停查看明细
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-xs text-stone-400">暂无客户会话的工具调用</p>
              )}
            </section>

            {/* 审批时效 */}
            <section className="rounded-container border border-hairline bg-surface px-5 py-4">
              <h2 className="text-sm font-medium text-stone-700">人工审批时效</h2>
              <div className="mt-3 flex items-baseline gap-4">
                <span className="text-2xl font-semibold tracking-tight text-stone-900">
                  {formatLatency(overview.avgApprovalLatencyMs)}
                </span>
                <span className="text-xs text-stone-500">
                  已决审批 {overview.decidedApprovalCount} 件 从创建到决定的平均耗时
                </span>
              </div>
            </section>

            {/* 满意度 */}
            <section className="rounded-container border border-hairline bg-surface px-5 py-4">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-medium text-stone-700">会话满意度 CSAT</h2>
                <span className="text-xs text-stone-500">
                  {overview.ratingCount > 0
                    ? `均分 ${overview.avgRating?.toFixed(1)} · ${overview.ratingCount} 条评价`
                    : '暂无评价 会话结束后客户可评分'}
                </span>
              </div>
              <div className="mt-3">
                <RatingColumns counts={overview.ratingCounts} />
              </div>
            </section>

            {/* CSAT 与终态交叉 */}
            {overview.ratingByFinalStatus.length > 0 && (
              <section className="rounded-container border border-hairline bg-surface px-5 py-4">
                <h2 className="text-sm font-medium text-stone-700">满意度 × 会话终态</h2>
                <p className="mt-1 text-xs text-stone-500">
                  AI 解决与人工解决的满意度对照 升级人工但满意 是人工价值的直接证据
                </p>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-stone-500">
                      <tr className="border-b border-hairline">
                        <th className="px-3 py-2 font-medium">终态</th>
                        <th className="px-3 py-2 font-medium">平均分</th>
                        <th className="px-3 py-2 font-medium">评价数</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                      {overview.ratingByFinalStatus.map((entry) => (
                        <tr
                          key={entry.status}
                          className="transition-colors duration-200 hover:bg-stone-50"
                        >
                          <td className="px-3 py-2 text-stone-700">
                            {STATUS_LABEL[entry.status] ?? entry.status}
                          </td>
                          <td className="px-3 py-2 tabular-nums text-stone-900">
                            {entry.avgScore.toFixed(1)}
                          </td>
                          <td className="px-3 py-2 tabular-nums text-stone-500">{entry.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <p className="text-xs text-stone-400">
              口径说明：{overview.scopeNote}。满意度为全终态收集 一会话一评 不参与评测任务成败判定。
              单 run 的 token 成本数据当前无落库来源 如实未纳入。
            </p>
          </div>
        ) : null}
      </div>
    </>
  )
}
