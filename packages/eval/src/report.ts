/**
 * 评测报告
 *
 * 输出 JSON 供程序消费 Markdown 供人读与归档
 * 报告带模型 提示词 代码版本三元组 对比实验可复现
 */

import { randomUUID } from 'node:crypto'
import type { EvalCase, EvalReport } from '@aftersales/contracts'
import type { CaseDetail } from './types.js'
import {
  computeMetrics,
  businessSuccessCount,
  metricDenominators,
  computePassPowerK,
  gateCheck,
  summarizeByCategory,
  wilson95,
  type MetricSummary,
} from './metrics.js'

export interface ReportInput {
  model: string
  promptVersion: string
  rounds: CaseDetail[][]
  /** Pass^k 的 k 值 */
  repeat: number
  /** 每轮的耗时毫秒 */
  roundDurationsMs: number[]
  cases: EvalCase[]
  /** L2 用户模拟的报告元数据 */
  level?: 'L1' | 'L2'
  userModel?: string
  judgeModel?: string
}

export function buildReport(input: ReportInput): EvalReport {
  const ids = input.cases.map((item) => item.id)
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    input.rounds.length !== input.repeat ||
    input.rounds.some(
      (round) =>
        round.length !== ids.length || round.some((detail, index) => detail.caseId !== ids[index]),
    )
  )
    throw new Error('报告轮次或样本顺序不完整 禁止合并不同分母')
  const details = input.rounds.flat()
  const metrics = computeMetrics(details)
  const denominators = metricDenominators(details)
  const byCategory = summarizeByCategory(details)
  const gate = gateCheck(details, input.cases)
  const passPowerK = input.rounds.length > 1 ? computePassPowerK(input.rounds) : undefined

  // Wilson 95% 区间仅 L2 抽样评测计算 L1 脚本回放无采样方差
  const confidenceIntervals =
    input.level === 'L2'
      ? {
          task_success_rate: wilson95(businessSuccessCount(details), details.length),
          ...(passPowerK !== undefined
            ? {
                passPowerK: wilson95(
                  input.rounds[0]!.filter((detail) =>
                    input.rounds.every((round) =>
                      round.some((d) => d.caseId === detail.caseId && d.passed),
                    ),
                  ).length,
                  input.rounds[0]!.length,
                ),
              }
            : {}),
        }
      : undefined

  const report: EvalReport = {
    metricVersion: 'p9-v1',
    metricDenominators: denominators,
    reportId: `evr_${randomUUID().slice(0, 8)}`,
    startedAt: new Date().toISOString(),
    level: input.level ?? 'L1',
    model: input.model,
    userModel: input.userModel,
    judgeModel: input.judgeModel,
    promptVersion: input.promptVersion,
    total: details.length,
    passed: details.filter((d) => d.passed).length,
    failed: details.filter((d) => !d.passed).length,
    passAtK: passAtK(input.rounds),
    passPowerK,
    confidenceIntervals,
    metrics: Object.fromEntries(
      Object.entries(metrics).filter(([key]) => denominators[key as keyof typeof denominators] > 0),
    ),
    byCategory,
    caseResults: details.map((d, index) => ({
      repeat: Math.floor(index / ids.length) + 1,
      caseId: d.caseId,
      category: d.category as never,
      priority: d.priority,
      passed: d.passed,
      failures: d.failures,
      durationMs: d.durationMs,
      turns: d.turns,
      agentInputTokens: d.agentInputTokens,
      agentOutputTokens: d.agentOutputTokens,
      agentCostUsd: d.agentCostUsd,
      simulatorInputTokens: d.simulatorInputTokens,
      simulatorOutputTokens: d.simulatorOutputTokens,
      simulatorCostUsd: d.simulatorCostUsd,
      judge: d.judge ? toContractJudge(d.judge) : undefined,
      runId: d.runId,
    })),
    gatePassed: gate.passed,
  }
  return report
}

function toContractJudge(failures: CaseDetail['judge']): NonNullable<CaseDetail['judge']> {
  return failures?.map((failure) => ({ rubric: failure.rubric, reason: failure.reason })) ?? []
}

/** Pass@k 至少一次通过 用于与 Pass^k 对照展示观察能力上限 */
function passAtK(rounds: CaseDetail[][]): Record<string, number> {
  const result: Record<string, number> = {}
  if (rounds.length < 2) return result
  const first = rounds[0]!
  const atLeastOnce = first.filter((detail) =>
    rounds.some((round) => round.some((d) => d.caseId === detail.caseId && d.passed)),
  )
  result[`pass@${rounds.length}`] = first.length === 0 ? 0 : atLeastOnce.length / first.length
  return result
}

/** Markdown 报告 人读归档用 */
export function renderMarkdownReport(
  report: EvalReport,
  extra: { repeat: number; durationMs: number },
): string {
  const lines: string[] = []
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`

  lines.push('# 评测报告')
  lines.push('')
  lines.push(`- 报告编号 ${report.reportId}`)
  lines.push(`- 生成时间 ${report.startedAt}`)
  lines.push(`- 层级 ${report.level} 模型 ${report.model} 提示词版本 ${report.promptVersion}`)
  if (report.level === 'L2') {
    lines.push(`- 用户模拟器 ${report.userModel} judge ${report.judgeModel ?? '未启用'}`)
  }
  lines.push(`- 重复轮次 ${extra.repeat} 总耗时 ${(extra.durationMs / 1000).toFixed(1)}s`)
  lines.push(`- P0 门禁 ${report.gatePassed ? '通过' : '未通过'}`)
  lines.push('')
  lines.push('## 总览')
  lines.push('')
  lines.push(
    `- 用例总数 ${report.total} 通过 ${report.passed} 失败 ${report.failed} 成功率 ${percent(report.passed / Math.max(report.total, 1))}`,
  )
  if (report.passPowerK !== undefined) {
    lines.push(`- Pass^${extra.repeat} ${percent(report.passPowerK)} 全部轮次均通过`)
  }
  for (const [key, value] of Object.entries(report.passAtK ?? {})) {
    lines.push(`- ${key} ${percent(value)}`)
  }
  const ci = report.confidenceIntervals
  if (ci) {
    const tsr = ci['task_success_rate']
    if (tsr) {
      lines.push(
        `- 任务成功率 95% Wilson 区间 [${percent(tsr.lower)}, ${percent(tsr.upper)}] 样本 ${report.total} 条`,
      )
    }
    const pk = ci['passPowerK']
    if (pk) {
      lines.push(
        `- Pass^${extra.repeat} 95% Wilson 区间 [${percent(pk.lower)}, ${percent(pk.upper)}]`,
      )
    }
    lines.push(`- 置信区间仅 L2 抽样评测计算 L1 脚本回放无采样方差不计算`)
  }
  if (report.level === 'L2') {
    const withTurns = report.caseResults.filter((c) => c.turns !== undefined)
    if (withTurns.length > 0) {
      const avgTurns = withTurns.reduce((sum, c) => sum + (c.turns ?? 0), 0) / withTurns.length
      const agentTokens = report.caseResults.reduce(
        (sum, c) => sum + (c.agentInputTokens ?? 0) + (c.agentOutputTokens ?? 0),
        0,
      )
      const simTokens = report.caseResults.reduce(
        (sum, c) => sum + (c.simulatorInputTokens ?? 0) + (c.simulatorOutputTokens ?? 0),
        0,
      )
      lines.push(`- 平均对话轮次 ${avgTurns.toFixed(1)}`)
      lines.push(`- Agent token ${agentTokens} 模拟器 token ${simTokens}`)
    }
  }
  lines.push('')
  lines.push('## 核心指标')
  lines.push('')
  lines.push('| 指标 | 数值 | 分母 |')
  lines.push('| --- | --- | --- |')
  for (const [key, value] of Object.entries(report.metrics)) {
    lines.push(
      `| ${key} | ${percent(value)} | ${report.metricDenominators?.[key] ?? '旧格式未记录'} |`,
    )
  }
  lines.push('')
  lines.push('## 分类结果')
  lines.push('')
  lines.push('| 分类 | 通过 | 总数 | 通过率 |')
  lines.push('| --- | --- | --- | --- |')
  for (const [category, entry] of Object.entries(report.byCategory)) {
    lines.push(
      `| ${category} | ${entry.passed} | ${entry.total} | ${percent(entry.passed / Math.max(entry.total, 1))} |`,
    )
  }
  lines.push('')
  if (report.caseResults.some((c) => !c.passed)) {
    lines.push('## 失败用例')
    lines.push('')
    for (const result of report.caseResults.filter((c) => !c.passed)) {
      lines.push(`### ${result.caseId} 第 ${result.repeat ?? '未记录'} 轮 [${result.priority}]`)
      lines.push('')
      for (const failure of result.failures) {
        lines.push(`- [${failure.kind}] ${failure.message}`)
      }
      lines.push('')
    }
  } else {
    lines.push('## 失败用例')
    lines.push('')
    lines.push('无')
    lines.push('')
  }
  return lines.join('\n')
}

export type { MetricSummary }
