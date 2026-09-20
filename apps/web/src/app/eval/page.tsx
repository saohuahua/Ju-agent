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
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">评测看板</h1>
            <p className="mt-1 text-xs text-slate-400">
              以数据库终态与工具轨迹为准的确定性评测 LLM 判分不参与任务成败
            </p>
          </div>
          <button
            onClick={trigger}
            disabled={running}
            className="rounded-md bg-sky-600 px-4 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {running ? '评测执行中' : '运行评测套件'}
          </button>
        </div>

        {error && (
          <p className="mt-4 rounded-md bg-red-950/50 px-3 py-2 text-sm text-red-300">{error}</p>
        )}

        {!latest && !running && (
          <div className="mt-6 rounded-lg border border-dashed border-slate-700 px-6 py-12 text-center text-sm text-slate-400">
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
                <h2 className="mb-2 text-sm font-medium text-slate-300">分层指标</h2>
                <div className="overflow-hidden rounded-lg border border-slate-800">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-900/80 text-left text-xs text-slate-400">
                      <tr>
                        <th className="px-4 py-2 font-medium">指标</th>
                        <th className="px-4 py-2 font-medium">数值</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {Object.entries(latest.report.metrics).map(([key, value]) => (
                        <tr key={key} className="bg-slate-900/30">
                          <td className="px-4 py-2">{METRIC_LABEL[key] ?? key}</td>
                          <td className="px-4 py-2 font-mono">{percent(value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {latest.report.byCategory && (
              <section className="mt-6">
                <h2 className="mb-2 text-sm font-medium text-slate-300">分类结果</h2>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {Object.entries(latest.report.byCategory).map(([category, entry]) => (
                    <div
                      key={category}
                      className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3"
                    >
                      <div className="text-xs text-slate-400">
                        {CATEGORY_LABEL[category] ?? category}
                      </div>
                      <div className="mt-1 text-lg font-semibold">
                        {entry.passed}
                        <span className="text-sm text-slate-400">/{entry.total}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="mt-6">
              <h2 className="mb-2 text-sm font-medium text-slate-300">历史报告</h2>
              <div className="overflow-hidden rounded-lg border border-slate-800">
                <table className="w-full text-sm">
                  <thead className="bg-slate-900/80 text-left text-xs text-slate-400">
                    <tr>
                      <th className="px-4 py-2 font-medium">报告</th>
                      <th className="px-4 py-2 font-medium">模型</th>
                      <th className="px-4 py-2 font-medium">通过率</th>
                      <th className="px-4 py-2 font-medium">门禁</th>
                      <th className="px-4 py-2 font-medium">时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {reports.map((report) => (
                      <tr key={report.reportId} className="bg-slate-900/30">
                        <td className="px-4 py-2 font-mono text-xs">{report.reportId}</td>
                        <td className="px-4 py-2 font-mono text-xs">{report.model}</td>
                        <td className="px-4 py-2">
                          {report.passed}/{report.total}
                        </td>
                        <td className="px-4 py-2">
                          <span className={report.gatePassed ? 'text-emerald-400' : 'text-red-400'}>
                            {report.gatePassed ? '通过' : '未通过'}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-xs text-slate-400">
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
    tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-red-400' : 'text-slate-100'
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  )
}
