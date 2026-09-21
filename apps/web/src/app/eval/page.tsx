'use client'

/**
 * 评测看板
 *
 * 展示最近评测报告的分层指标与分类结果
 * 支持一键触发脚本化套件 约 2 秒
 */

import { useCallback, useEffect, useState } from 'react'
import { AppShell } from '@/components/AppShell'
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

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

export default function EvalPage() {
  const [reports, setReports] = useState<EvalReportSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    try {
      const body = await api.listEvalReports()
      setReports(body.reports)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '加载失败')
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

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl px-6 py-8">
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

        {!latest && !running && (
          <div className="mt-6 rounded-container border border-dashed border-stone-300 px-6 py-12 text-center text-sm text-stone-500">
            暂无评测报告 点击右上角运行评测套件
          </div>
        )}

        {latest && (
          <>
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MetricTile label="用例总数" value={String(latest.total)} />
              <MetricTile label="通过" value={String(latest.passed)} tone="good" />
              <MetricTile
                label="失败"
                value={String(latest.failed)}
                tone={latest.failed > 0 ? 'bad' : undefined}
              />
              <MetricTile
                label="P0 门禁"
                value={latest.gatePassed ? '通过' : '未通过'}
                tone={latest.gatePassed ? 'good' : 'bad'}
              />
            </div>

            {latest.report.metrics && (
              <section className="mt-6">
                <h2 className="mb-2 text-sm font-medium text-stone-700">分层指标</h2>
                <div className="overflow-hidden rounded-container border border-hairline bg-white">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-stone-500">
                      <tr className="border-b border-hairline bg-stone-50">
                        <th className="px-4 py-2 font-medium">指标</th>
                        <th className="px-4 py-2 font-medium">数值</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                      {Object.entries(latest.report.metrics).map(([key, value]) => (
                        <tr key={key}>
                          <td className="px-4 py-2 text-stone-700">{METRIC_LABEL[key] ?? key}</td>
                          <td className="px-4 py-2 font-mono tabular-nums text-stone-900">
                            {percent(value)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {latest.report.byCategory && (
              <section className="mt-6">
                <h2 className="mb-2 text-sm font-medium text-stone-700">分类结果</h2>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {Object.entries(latest.report.byCategory).map(([category, entry]) => (
                    <div
                      key={category}
                      className="rounded-container border border-hairline bg-white px-4 py-3"
                    >
                      <div className="text-xs text-stone-500">
                        {CATEGORY_LABEL[category] ?? category}
                      </div>
                      <div className="mt-1 text-lg font-semibold tabular-nums tracking-tight text-stone-900">
                        {entry.passed}
                        <span className="text-sm font-normal text-stone-400">/{entry.total}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="mt-6">
              <h2 className="mb-2 text-sm font-medium text-stone-700">历史报告</h2>
              <div className="overflow-x-auto rounded-container border border-hairline bg-white">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-stone-500">
                    <tr className="border-b border-hairline bg-stone-50">
                      <th className="px-4 py-2 font-medium">报告</th>
                      <th className="px-4 py-2 font-medium">模型</th>
                      <th className="px-4 py-2 font-medium">通过率</th>
                      <th className="px-4 py-2 font-medium">门禁</th>
                      <th className="px-4 py-2 font-medium">时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {reports.map((report) => (
                      <tr key={report.reportId} className="transition-colors duration-200 hover:bg-stone-50">
                        <td className="px-4 py-2 font-mono text-xs text-stone-600">
                          {report.reportId}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-stone-600">
                          {report.model}
                        </td>
                        <td className="px-4 py-2 tabular-nums text-stone-700">
                          {report.passed}/{report.total}
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={
                              report.gatePassed ? 'text-emerald-700' : 'text-red-700'
                            }
                          >
                            {report.gatePassed ? '通过' : '未通过'}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-xs tabular-nums text-stone-500">
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

function MetricTile({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'good' | 'bad'
}) {
  const toneClass =
    tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-red-700' : 'text-stone-900'
  return (
    <div className="rounded-container border border-hairline bg-white px-4 py-3">
      <div className="text-xs text-stone-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums tracking-tight ${toneClass}`}>
        {value}
      </div>
    </div>
  )
}
