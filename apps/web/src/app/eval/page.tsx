'use client'

/**
 * 评测看板
 *
 * 展示最近评测报告的分层指标与分类结果
 * 支持一键触发脚本化套件 约 2 秒
 * 视觉：极简排版式指标 大数字加留白分层 不用框线卡片
 */

import { Gauge } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { AppShell } from '@/components/AppShell'
import { Skeleton } from '@/components/Skeleton'
import { api } from '@/lib/api'
import type { EvalReportSummary } from '@/lib/types'

const METRIC_LABEL: Record<string, string> = {
  task_success_rate: '任务成功率 TSR',
  side_effect_correctness: '副作用正确率',
  tool_selection_accuracy: '工具选择正确率',
  tool_argument_accuracy: '工具参数正确率',
  policy_violation_rate: '政策违规率',
  duplicate_side_effect_rate: '重复副作用率',
  checkpoint_recovery_rate: '断点恢复成功率',
  injection_defense_rate: '注入防御率',
  clarification_quality: '补问质量',
  escalation_correctness: '升级正确率',
}

const CATEGORY_LABEL: Record<string, string> = {
  happy_path: '主链路',
  clarification: '多轮补问',
  policy_boundary: '政策边界',
  approval: '人工审批',
  rejection: '拒绝冲突',
  fault_injection: '故障注入',
  security: '安全防御',
  recovery: '恢复幂等',
}

/** 分层指标分组 组间 hairline 分割 */
const METRIC_GROUPS: Array<{ title: string; keys: string[] }> = [
  {
    title: '正确性',
    keys: [
      'task_success_rate',
      'side_effect_correctness',
      'tool_selection_accuracy',
      'tool_argument_accuracy',
    ],
  },
  {
    title: '安全治理',
    keys: ['policy_violation_rate', 'duplicate_side_effect_rate', 'injection_defense_rate'],
  },
  {
    title: '恢复协同',
    keys: ['checkpoint_recovery_rate', 'clarification_quality', 'escalation_correctness'],
  },
]

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

export default function EvalPage() {
  const [reports, setReports] = useState<EvalReportSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const body = await api.listEvalReports()
      setReports(body.reports)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const trigger = async () => {
    if (running) return
    setRunning(true)
    try {
      await api.runEval()
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '评测失败')
    } finally {
      setRunning(false)
    }
  }

  const latest = reports[0]
  const groupedKeys = new Set(METRIC_GROUPS.flatMap((group) => group.keys))

  return (
    <AppShell>
      <div className="page-enter mx-auto max-w-5xl px-6 py-8">
        <div className="flex items-center justify-between gap-6">
          <h1 className="shrink-0 text-xl font-semibold tracking-tight">评测看板</h1>
          <div className="flex min-w-0 items-center gap-5">
            <p className="min-w-0 text-sm text-stone-500">
              以数据库终态与工具轨迹为准的确定性评测 LLM 判分不参与任务成败
            </p>
            <button
              onClick={trigger}
              disabled={running}
              className="shrink-0 rounded-control bg-sage-700 px-4 py-2 text-xs font-medium text-white transition-colors duration-200 hover:bg-sage-800 active:scale-[0.98] disabled:opacity-50"
            >
              {running ? '评测执行中' : '运行评测套件'}
            </button>
          </div>
        </div>

        {error && (
          <p className="mt-4 rounded-control border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        {loading && (
          <>
            <div className="mt-8 flex flex-wrap items-end gap-x-12 gap-y-6 border-b border-hairline pb-8">
              {[0, 1, 2, 3].map((index) => (
                <div key={index}>
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="mt-2 h-10 w-20" />
                </div>
              ))}
            </div>
            <div className="mt-8 space-y-2.5">
              {[0, 1, 2, 3, 4].map((index) => (
                <Skeleton key={index} className="h-5 w-full max-w-md" />
              ))}
            </div>
          </>
        )}

        {!loading && !latest && !running && (
          <div className="mt-6 flex flex-col items-center gap-2 rounded-container border border-dashed border-stone-300 px-6 py-12 text-sm text-stone-500">
            <Gauge size={28} className="text-stone-300" aria-hidden="true" />
            <span>暂无评测报告 点击右上角运行评测套件</span>
          </div>
        )}

        {!loading && latest && (
          <>
            <div className="mt-8 flex flex-wrap items-end gap-x-12 gap-y-6 border-b border-hairline pb-8">
              <div>
                <div className="text-xs text-stone-500">用例总数</div>
                <div className="mt-1 text-5xl font-semibold tabular-nums tracking-tight text-stone-900">
                  {latest.total}
                </div>
              </div>
              <div>
                <div className="text-xs text-stone-500">通过</div>
                <div className="mt-1 text-5xl font-semibold tabular-nums tracking-tight text-emerald-700">
                  {latest.passed}
                </div>
              </div>
              <div>
                <div className="text-xs text-stone-500">失败</div>
                <div
                  className={`mt-1 text-5xl font-semibold tabular-nums tracking-tight ${
                    latest.failed > 0 ? 'text-red-700' : 'text-stone-900'
                  }`}
                >
                  {latest.failed}
                </div>
              </div>
              <div>
                <div className="text-xs text-stone-500">P0 门禁</div>
                <div
                  className={`mt-1 text-5xl font-semibold tracking-tight ${
                    latest.gatePassed ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  {latest.gatePassed ? '通过' : '未通过'}
                </div>
              </div>
            </div>

            {latest.report.metrics && (
              <section className="mt-8">
                <h2 className="text-sm font-medium text-stone-700">分层指标</h2>
                <div className="mt-2">
                  {METRIC_GROUPS.map((group, groupIndex) => {
                    const rows = group.keys
                      .map((key) => [key, latest.report.metrics![key]] as const)
                      .filter((entry): entry is readonly [string, number] => entry[1] !== undefined)
                    if (rows.length === 0) return null
                    return (
                      <div
                        key={group.title}
                        className={groupIndex > 0 ? 'mt-3 border-t border-hairline pt-2' : ''}
                      >
                        <div className="text-xs font-medium text-stone-500">{group.title}</div>
                        <div className="mt-1">
                          {rows.map(([key, value]) => (
                            <div
                              key={key}
                              className="flex items-center justify-between py-1.5"
                            >
                              <span className="text-sm text-stone-700">
                                {METRIC_LABEL[key] ?? key}
                              </span>
                              <span className="font-mono text-sm tabular-nums text-stone-900">
                                {percent(value)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                  {Object.entries(latest.report.metrics)
                    .filter(([key]) => !groupedKeys.has(key))
                    .map(([key, value], index) => (
                      <div
                        key={key}
                        className={`flex items-center justify-between py-1.5 ${
                          index === 0 ? 'mt-3 border-t border-hairline pt-2' : ''
                        }`}
                      >
                        <span className="text-sm text-stone-700">{METRIC_LABEL[key] ?? key}</span>
                        <span className="font-mono text-sm tabular-nums text-stone-900">
                          {percent(value)}
                        </span>
                      </div>
                    ))}
                </div>
              </section>
            )}

            {latest.report.byCategory && (
              <section className="mt-8">
                <h2 className="mb-2 text-sm font-medium text-stone-700">分类结果</h2>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {Object.entries(latest.report.byCategory).map(([category, entry]) => {
                    const allPassed = entry.passed === entry.total
                    return (
                      <div
                        key={category}
                        className={`rounded-container border px-4 py-3 ${
                          allPassed
                            ? 'border-emerald-200 bg-emerald-50'
                            : 'border-orange-200 bg-orange-50'
                        }`}
                      >
                        <div
                          className={`text-xs ${allPassed ? 'text-emerald-700' : 'text-orange-700'}`}
                        >
                          {CATEGORY_LABEL[category] ?? category}
                        </div>
                        <div
                          className={`mt-1 text-2xl font-semibold tabular-nums tracking-tight ${
                            allPassed ? 'text-emerald-800' : 'text-orange-800'
                          }`}
                        >
                          {entry.passed}
                          <span
                            className={`text-base font-normal ${
                              allPassed ? 'text-emerald-700' : 'text-orange-700'
                            }`}
                          >
                            /{entry.total}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
            )}

            <section className="mt-8">
              <h2 className="mb-2 text-sm font-medium text-stone-700">历史报告</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-stone-500">
                    <tr className="border-b border-hairline">
                      <th className="px-4 py-2.5 font-medium">报告</th>
                      <th className="px-4 py-2.5 font-medium">模型</th>
                      <th className="px-4 py-2.5 font-medium">通过率</th>
                      <th className="px-4 py-2.5 font-medium">门禁</th>
                      <th className="px-4 py-2.5 font-medium">时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {reports.map((report) => (
                      <tr
                        key={report.reportId}
                        className="transition-colors duration-200 hover:bg-stone-100"
                      >
                        <td className="px-4 py-2.5 font-mono text-xs text-stone-600">
                          {report.reportId}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs text-stone-600">
                          {report.model}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums text-stone-700">
                          {report.passed}/{report.total}
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`inline-flex items-center rounded-badge border px-2 py-0.5 text-[11px] font-medium ${
                              report.gatePassed
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                                : 'border-red-200 bg-red-50 text-red-800'
                            }`}
                          >
                            {report.gatePassed ? '通过' : '未通过'}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs tabular-nums text-stone-500">
                          {new Date(report.startedAt).toLocaleString('zh-CN')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </AppShell>
  )
}
