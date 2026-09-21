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
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AnthropicModel, PROMPT_VERSION } from '@aftersales/agent'
import { openDatabase, saveEvalReport } from '@aftersales/persistence'
import { SIM_CASES } from './index.js'
import { runSimCase } from './index.js'
import { buildReport, renderMarkdownReport } from './index.js'
import type { CaseDetail } from './index.js'
import type { ChatModel } from '@aftersales/agent'

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

interface SimCliOptions {
  repeat: number
  sample: 'p0' | 'p1' | 'p2' | 'all'
  agentModel: string
  userModel: string
  judgeModel: string
  gate: boolean
  caseId: string | null
}

const DEFAULT_AGENT_MODEL = 'claude-sonnet-5'
const DEFAULT_USER_MODEL = 'claude-haiku-4-5-20251001'
const DEFAULT_JUDGE_MODEL = 'claude-sonnet-5'

function parseArgs(argv: string[]): SimCliOptions {
  const options: SimCliOptions = {
    repeat: 1,
    sample: 'p0',
    agentModel: process.env.ANTHROPIC_MODEL ?? DEFAULT_AGENT_MODEL,
    userModel: process.env.SIM_USER_MODEL ?? DEFAULT_USER_MODEL,
    judgeModel: process.env.SIM_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
    gate: false,
    caseId: null,
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
      options.caseId = argv[i + 1] ?? null
      i += 1
    }
  }
  return options
}

/** 分层抽样 P0 全量 P1 二分之一 P2 五分之一 固定间隔保证可复现 */
function selectCases(sample: SimCliOptions['sample'], caseId: string | null): typeof SIM_CASES {
  if (caseId) {
    const found = SIM_CASES.filter((testCase) => testCase.id === caseId)
    if (found.length === 0) {
      throw new Error(`用例 ${caseId} 不存在或缺少 scenario`)
    }
    return found
  }
  switch (sample) {
    case 'all':
      return SIM_CASES
    case 'p0':
      return SIM_CASES.filter((testCase) => testCase.priority === 'P0')
    case 'p1':
      return SIM_CASES.filter((testCase) => testCase.priority === 'P1').filter(
        (_, index) => index % 2 === 0,
      )
    case 'p2':
      return SIM_CASES.filter((testCase) => testCase.priority === 'P2').filter(
        (_, index) => index % 5 === 0,
      )
  }
}

function buildModel(model: string): ChatModel {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('MISSING_KEY')
  }
  return new AnthropicModel({ model })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 判定失败是否为模型服务瞬态错误 中转站限流与上游抖动 */
function isTransientFailure(detail: CaseDetail): boolean {
  return (
    (detail.turns ?? 0) === 0 &&
    detail.failures.some(
      (failure) => failure.includes('模型服务异常') || failure.includes('模型服务限流'),
    )
  )
}

/** 用例级重试 瞬态模型服务错误不计入 Agent 成绩 */
async function runCaseWithRetry(
  simCase: Parameters<typeof runSimCase>[0],
  options: Parameters<typeof runSimCase>[1],
  maxAttempts = 3,
): Promise<CaseDetail> {
  let detail = await runSimCase(simCase, options)
  for (let attempt = 2; attempt <= maxAttempts && isTransientFailure(detail); attempt++) {
    console.log(`      ${simCase.id} 模型服务瞬态错误 第 ${attempt} 次重试`)
    await sleep(3000)
    detail = await runSimCase(simCase, options)
  }
  return detail
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

  let agentModel: ChatModel
  let userModel: ChatModel
  let judgeModel: ChatModel
  try {
    agentModel = buildModel(options.agentModel)
    userModel = buildModel(options.userModel)
    judgeModel = buildModel(options.judgeModel)
  } catch {
    console.log('模型构造失败 请检查 ANTHROPIC_API_KEY 与网络')
    process.exitCode = 1
    return
  }

  console.log(
    `L2 用户模拟评测 被测 ${options.agentModel} 模拟器 ${options.userModel} judge ${options.judgeModel}\n` +
      `用例 ${cases.length} 条 重复 ${options.repeat} 轮 抽样 ${options.sample}`,
  )

  const failureDir = resolve(process.cwd(), 'eval', 'failures')
  const rounds: CaseDetail[][] = []
  const roundDurationsMs: number[] = []
  for (let round = 1; round <= options.repeat; round++) {
    const startedAt = Date.now()
    const details: CaseDetail[] = []
    for (const simCase of cases) {
      const detail = await runCaseWithRetry(simCase, {
        agentModel,
        userModel,
        judgeModel,
        failureDir,
      })
      details.push(detail)
      const mark = detail.passed ? '通过' : '失败'
      const turns = detail.turns ?? 0
      const tokens = (detail.agentInputTokens ?? 0) + (detail.agentOutputTokens ?? 0)
      console.log(
        `  [${detail.priority}] ${detail.caseId} ${mark} ${detail.durationMs}ms ${turns}轮 ${tokens}tok`,
      )
      if (!detail.passed) {
        for (const failure of detail.failures) {
          console.log(`      ${failure}`)
        }
      }
      // 用例间节流 缓解中转站突发限流 评测测 Agent 不测基建
      await sleep(1500)
    }
    rounds.push(details)
    roundDurationsMs.push(Date.now() - startedAt)
    const passed = details.filter((d) => d.passed).length
    console.log(`第 ${round} 轮完成 通过 ${passed}/${details.length}`)
  }

  const report = buildReport({
    model: options.agentModel,
    promptVersion: PROMPT_VERSION,
    rounds,
    repeat: options.repeat,
    roundDurationsMs,
    cases,
    level: 'L2',
    userModel: options.userModel,
    judgeModel: options.judgeModel,
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
      durationMs: roundDurationsMs.reduce((a, b) => a + b, 0),
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
