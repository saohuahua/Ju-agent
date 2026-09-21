/**
 * 评测命令行入口
 *
 * 用法
 *   pnpm eval                      脚本化模型跑一轮
 *   pnpm eval -- --repeat 3        同一用例集跑三轮计算 Pass^3
 *   pnpm eval -- --model anthropic 接入真实模型 需要配置密钥
 *
 * P0 用例失败时进程以非零码退出 供 CI 门禁使用
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AnthropicModel, PROMPT_VERSION } from '@aftersales/agent'
import { openDatabase, saveEvalReport } from '@aftersales/persistence'
import { EVAL_CASES, buildReport, renderMarkdownReport, runCase } from './index.js'
import type { CaseDetail } from './index.js'

interface CliOptions {
  repeat: number
  model: 'scripted' | 'anthropic'
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { repeat: 1, model: 'scripted' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--repeat') {
      options.repeat = Math.max(1, Number(argv[i + 1] ?? 1))
      i += 1
    } else if (arg === '--model') {
      const value = argv[i + 1]
      if (value === 'anthropic' || value === 'scripted') {
        options.model = value
      }
      i += 1
    }
  }
  return options
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  console.log(
    `评测开始 模型 ${options.model} 用例 ${EVAL_CASES.length} 条 重复 ${options.repeat} 轮`,
  )

  // 真实模型模式下由模型按提示词自由决策 每轮结果可能波动 Pass^k 才有意义
  const realModel = options.model === 'anthropic' ? new AnthropicModel() : null
  const rounds: CaseDetail[][] = []
  const roundDurationsMs: number[] = []
  for (let round = 1; round <= options.repeat; round++) {
    const startedAt = Date.now()
    const details: CaseDetail[] = []
    for (const testCase of EVAL_CASES) {
      const detail = await runCase(testCase, realModel ? { model: realModel } : {})
      details.push(detail)
      const mark = detail.passed ? '通过' : '失败'
      console.log(`  [${detail.priority}] ${detail.caseId} ${mark} ${detail.durationMs}ms`)
      if (!detail.passed) {
        for (const failure of detail.failures) {
          console.log(`      [${failure.kind}] ${failure.message}`)
        }
      }
    }
    rounds.push(details)
    roundDurationsMs.push(Date.now() - startedAt)
    const passed = details.filter((d) => d.passed).length
    console.log(`第 ${round} 轮完成 通过 ${passed}/${details.length}`)
  }

  const report = buildReport({
    model: realModel ? realModel.info.model : 'scripted-v1',
    promptVersion: PROMPT_VERSION,
    rounds,
    repeat: options.repeat,
    roundDurationsMs,
    cases: EVAL_CASES,
  })

  // 报告落盘 JSON 与 Markdown 双格式
  const reportDir = resolve(process.cwd(), 'eval', 'reports')
  mkdirSync(reportDir, { recursive: true })
  const jsonPath = resolve(reportDir, `${report.reportId}.json`)
  const markdownPath = resolve(reportDir, `${report.reportId}.md`)
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8')
  writeFileSync(
    markdownPath,
    renderMarkdownReport(report, {
      repeat: options.repeat,
      durationMs: roundDurationsMs.reduce((a, b) => a + b, 0),
    }),
    'utf-8',
  )

  // 报告写入业务数据库供看板查询
  const db = openDatabase(process.env.DB_PATH ?? './data/app.db')
  saveEvalReport(db, {
    reportId: report.reportId,
    startedAt: report.startedAt,
    model: report.model,
    promptVersion: report.promptVersion,
    total: report.total,
    passed: report.passed,
    failed: report.failed,
    gatePassed: report.gatePassed,
    report,
  })

  console.log(`报告已生成 ${markdownPath}`)
  console.log(
    `总通过率 ${report.passed}/${report.total} P0 门禁 ${report.gatePassed ? '通过' : '未通过'}`,
  )
  if (report.passPowerK !== undefined) {
    console.log(`Pass^${options.repeat} ${(report.passPowerK * 100).toFixed(1)}%`)
  }

  if (!report.gatePassed) {
    process.exitCode = 1
  }
}

await main()
