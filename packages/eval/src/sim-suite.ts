/**
 * L2 用户模拟评测套件运行器
 *
 * CLI 与 API 端点共用的核心逻辑 模型构造 抽样 多轮循环 报告构建
 * 进度回调供调用方呈现 落盘与存库由调用方负责
 */

import { AnthropicModel, PROMPT_VERSION } from '@aftersales/agent'
import type { ChatModel } from '@aftersales/agent'
import type { EvalReport } from '@aftersales/contracts'
import { buildReport } from './report.js'
import { runSimCase } from './sim-runner.js'
import { SIM_CASES } from './cases.js'
import type { CaseDetail } from './types.js'

export interface SimSuiteOptions {
  repeat: number
  sample: 'p0' | 'p1' | 'p2' | 'all'
  agentModel: string
  userModel: string
  judgeModel: string
  /** 单用例调试 存在时忽略抽样 */
  caseId?: string
  failureDir?: string
  /** 每完成一条用例回调一次 供进度展示 */
  onProgress?: (progress: SimSuiteProgress) => void
}

export interface SimSuiteProgress {
  /** 当前轮 从 1 起 */
  round: number
  repeat: number
  /** 本轮已完成用例数 */
  caseIndex: number
  totalCases: number
  /** 当前用例编号 */
  caseId: string
  /** 本轮累计通过与失败 */
  passed: number
  failed: number
  /** 本轮已用毫秒 */
  elapsedMs: number
  /** 当前用例失败明细 通过时为空 */
  failures: Array<{ kind: string; message: string }>
}

export const DEFAULT_AGENT_MODEL = 'claude-sonnet-5'
export const DEFAULT_USER_MODEL = 'claude-haiku-4-5-20251001'
export const DEFAULT_JUDGE_MODEL = 'claude-sonnet-5'

/** 分层抽样 P0 全量 P1 二分之一 P2 五分之一 固定间隔保证可复现 */
export function selectCases(
  sample: SimSuiteOptions['sample'],
  caseId: string | undefined,
): typeof SIM_CASES {
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

/** 单条用例估算 token 用于成本预估展示 取连通性验证的样本均值 */
export function estimateSuiteTokens(count: number, repeat: number): number {
  return Math.round(count * repeat * 3500)
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

/** 判定失败是否为模型服务瞬态错误 中转站限流与上游抖动 按结构化 kind 判定 */
function isTransientFailure(detail: CaseDetail): boolean {
  return (
    (detail.turns ?? 0) === 0 &&
    detail.failures.some(
      (failure) =>
        failure.kind === 'exception' &&
        (failure.message.includes('模型服务异常') || failure.message.includes('模型服务限流')),
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

/** 执行全量 L2 套件 返回构建好的报告 不落盘不存库 */
export async function runSimSuite(options: SimSuiteOptions): Promise<EvalReport> {
  const cases = selectCases(options.sample, options.caseId)
  if (cases.length === 0) {
    throw new Error('选中的用例集为空 检查 sample 参数或用例 scenario 配置')
  }

  const agentModel = buildModel(options.agentModel)
  const userModel = buildModel(options.userModel)
  const judgeModel = buildModel(options.judgeModel)

  const rounds: CaseDetail[][] = []
  const roundDurationsMs: number[] = []
  for (let round = 1; round <= options.repeat; round++) {
    const startedAt = Date.now()
    const details: CaseDetail[] = []
    let passed = 0
    let failed = 0
    let caseIndex = 0
    for (const simCase of cases) {
      // 用例级模拟器模型覆盖 安全对抗类用例 Haiku 拒绝扮演攻击者 需按用例指定更强模型
      const caseUserModel = simCase.userModel ? buildModel(simCase.userModel) : userModel
      const detail = await runCaseWithRetry(simCase, {
        agentModel,
        userModel: caseUserModel,
        judgeModel,
        failureDir: options.failureDir,
      })
      details.push(detail)
      caseIndex += 1
      if (detail.passed) passed += 1
      else failed += 1
      options.onProgress?.({
        round,
        repeat: options.repeat,
        caseIndex,
        totalCases: cases.length,
        caseId: simCase.id,
        passed,
        failed,
        elapsedMs: Date.now() - startedAt,
        failures: detail.failures.map((f) => ({ kind: f.kind, message: f.message })),
      })
      // 用例间节流 缓解中转站突发限流 评测测 Agent 不测基建
      await sleep(1500)
    }
    rounds.push(details)
    roundDurationsMs.push(Date.now() - startedAt)
  }

  return buildReport({
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
}
