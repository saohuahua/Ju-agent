/**
 * L2 用户模拟评测命令行入口
 *
 * 用法
 *   pnpm eval:sim                          P0 全量 单轮
 *   pnpm eval:sim -- --repeat 3            P0 全量 三轮 计算 Pass^3
 *   pnpm eval:sim -- --sample all          全部带场景用例
 *   pnpm eval:sim -- --sample p0|p1|p2     分层抽样 P1 抽一半 P2 抽五分之一
 *   pnpm eval:sim -- --case hp_query_order_status     单用例调试
 *   pnpm eval:sim -- --gate                P0 全过才通过 CI 发布门禁
 *
 * 需要 ANTHROPIC_API_KEY 未配置时输出跳过说明并以零码退出 不伪装成绩
 * 模拟器与被测模型分离 judge 与两者分离
 * 套件核心逻辑在 sim-suite.ts 与 API 端点共用
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, saveEvalReport } from '@aftersales/persistence'
import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_USER_MODEL,
  estimateSuiteTokens,
  runSimSuite,
  selectCases,
  type SimSuiteOptions,
} from './sim-suite.js'
import { renderMarkdownReport } from './index.js'

/** 加载仓库根目录 .env 与 API 入口同一逻辑 显式覆盖同名变量 */
function loadEnvFile(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const file = resolve(repoRoot, '.env')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key) process.env[key] = value
  }
}
loadEnvFile()

interface SimCliOptions extends Omit<SimSuiteOptions, 'failureDir' | 'onProgress'> {
  gate: boolean
}

function parseArgs(argv: string[]): SimCliOptions {
  const options: SimCliOptions = {
    repeat: 1,
    sample: 'p0',
    agentModel: process.env.ANTHROPIC_MODEL ?? DEFAULT_AGENT_MODEL,
    userModel: process.env.SIM_USER_MODEL ?? DEFAULT_USER_MODEL,
    judgeModel: process.env.SIM_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
    gate: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--repeat') {
      options.repeat = Math.max(1, Number(argv[i + 1] ?? 1))
      i += 1
    } else if (arg === '--sample') {
      const value = argv[i + 1]
      if (value === 'p0' || value === 'p1' || value === 'p2' || value === 'all') {
        options.sample = value
      }
      i += 1
    } else if (arg === '--agent-model') {
      options.agentModel = argv[i + 1] ?? options.agentModel
      i += 1
    } else if (arg === '--user-model') {
      options.userModel = argv[i + 1] ?? options.userModel
      i += 1
    } else if (arg === '--judge-model') {
      options.judgeModel = argv[i + 1] ?? options.judgeModel
      i += 1
    } else if (arg === '--gate') {
      options.gate = true
    } else if (arg === '--case') {
      options.caseId = argv[i + 1] ?? undefined
      i += 1
    }
  }
  return options
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      '跳过 L2 用户模拟评测 未配置 ANTHROPIC_API_KEY\n' +
        'L1 脚本化回归不受影响 请配置密钥后运行 pnpm eval:sim 获取真实模型成绩\n' +
        '诚实原则 不输出模拟成绩',
    )
    return
  }

  const cases = selectCases(options.sample, options.caseId)
  if (cases.length === 0) {
    console.log('选中的用例集为空 检查 sample 参数或用例 scenario 配置')
    return
  }

  console.log(
    `L2 用户模拟评测 被测 ${options.agentModel} 模拟器 ${options.userModel} judge ${options.judgeModel}\n` +
      `用例 ${cases.length} 条 重复 ${options.repeat} 轮 抽样 ${options.sample}\n` +
      `估算 token 约 ${(estimateSuiteTokens(cases.length, options.repeat) / 10000).toFixed(1)} 万`,
  )

  const failureDir = resolve(process.cwd(), 'eval', 'failures')
  const startedAt = Date.now()
  const report = await runSimSuite({
    ...options,
    failureDir,
    onProgress: (progress) => {
      console.log(
        `  [${progress.round}-${progress.caseIndex}] ${progress.caseId} 通过 ${progress.passed} 失败 ${progress.failed} 第 ${progress.round}/${progress.repeat} 轮 用例 ${progress.caseIndex}/${progress.totalCases} ${(progress.elapsedMs / 1000).toFixed(0)}s`,
      )
      for (const failure of progress.failures) {
        console.log(`      [${failure.kind}] ${failure.message}`)
      }
    },
  })

  const reportDir = resolve(process.cwd(), 'eval', 'reports')
  mkdirSync(reportDir, { recursive: true })
  const jsonPath = resolve(reportDir, `${report.reportId}.json`)
  const markdownPath = resolve(reportDir, `${report.reportId}.md`)
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8')
  writeFileSync(
    markdownPath,
    renderMarkdownReport(report, {
      repeat: options.repeat,
      durationMs: Date.now() - startedAt,
    }),
    'utf-8',
  )

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
  const ci = report.confidenceIntervals
  if (ci) {
    const tsr = ci['task_success_rate']
    if (tsr) {
      console.log(
        `任务成功率 95% Wilson 区间 [${(tsr.lower * 100).toFixed(1)}%, ${(tsr.upper * 100).toFixed(1)}%]`,
      )
    }
  }
  const failedCases = report.caseResults.filter((c) => !c.passed).length
  if (failedCases > 0) {
    console.log(`失败用例已导出 ${failureDir}`)
  }

  const gateMode = options.gate || options.sample === 'p0'
  if (gateMode && !report.gatePassed) {
    process.exitCode = 1
  }
}

await main()
