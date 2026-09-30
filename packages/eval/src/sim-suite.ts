/**
 * L2 用户模拟评测套件运行器
 *
 * CLI 与 API 端点共用的核心逻辑 模型构造 抽样 多轮循环 报告构建
 * 进度回调供调用方呈现 落盘与存库由调用方负责
 */

import { PROMPT_VERSION } from '@aftersales/agent'
import { P7Ledger } from '@aftersales/persistence'
import { buildReport } from './report.js'
import { runSimCase } from './sim-runner.js'
import { SIM_CASES } from './cases.js'
import type { CaseDetail } from './types.js'
import { evaluationMetadata } from './p9-metadata.js'
import {
  executeBudgetedCase,
  suiteEvidence,
  type P7SuiteBudget,
  type P7CaseEvidence,
  type P7SuiteResult,
} from './p7-suite-entry.js'

export interface SimSuiteOptions {
  budget: P7SuiteBudget
  repeat: number
  sample: 'p0' | 'p1' | 'p2' | 'all'
  agentModel: string
  userModel: string
  judgeModel: string
  /** 单用例调试 存在时忽略抽样 */
  caseId?: string
  /** 分段专项 存在时在抽样结果上再按 category 过滤 安全段迭代用 */
  category?: string
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

/**
 * 分层抽样 P0 全量 P1 二分之一 P2 五分之一 固定间隔保证可复现
 *
 * category 在抽样之后再过滤 语义是「该分段在既定抽样口径下的表现」
 * 若先过滤再抽样 分段样本会与全量跑的同名用例集不一致 两次成绩不可比
 */
export function selectCases(
  sample: SimSuiteOptions['sample'],
  caseId: string | undefined,
  category?: string,
): typeof SIM_CASES {
  if (caseId) {
    const found = SIM_CASES.filter((testCase) => testCase.id === caseId)
    if (found.length === 0) {
      throw new Error(`用例 ${caseId} 不存在或缺少 scenario`)
    }
    return found
  }
  const sampled = (() => {
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
  })()
  return category ? sampled.filter((testCase) => testCase.category === category) : sampled
}

/** 单条用例估算 token 用于成本预估展示 取连通性验证的样本均值 */
export function estimateSuiteTokens(count: number, repeat: number): number {
  return Math.round(count * repeat * 3500)
}

/** 执行全量 L2 套件 返回构建好的报告 不落盘不存库 */
export async function runSimSuite(options: SimSuiteOptions): Promise<P7SuiteResult> {
  if (!options.budget) throw new Error('评测必须提供共享预算账本')
  if (!Number.isSafeInteger(options.repeat) || options.repeat < 1 || options.repeat > 20)
    throw new Error('重复轮次须为一至二十的整数')
  const cases = selectCases(options.sample, options.caseId, options.category)
  if (cases.length === 0) {
    throw new Error('选中的用例集为空 检查 sample 参数或用例 scenario 配置')
  }

  const evidence: P7CaseEvidence[] = []
  const metadata = evaluationMetadata(cases, options.repeat, 'L2')
  const ledger = new P7Ledger(options.budget.db)

  const rounds: CaseDetail[][] = []
  const roundDurationsMs: number[] = []
  for (let round = 1; round <= options.repeat; round++) {
    const startedAt = Date.now()
    const details: CaseDetail[] = []
    let passed = 0
    let failed = 0
    let caseIndex = 0
    for (const simCase of cases) {
      // 角色及用例覆盖只经受信配置解析器 网关之外不再重跑整条业务链
      const observed = await executeBudgetedCase(options.budget, simCase, round, ledger, (models) =>
        runSimCase(simCase, {
          agentModel: models.agentModel,
          userModel: models.userModel,
          judgeModel: models.judgeModel,
          failureDir: options.failureDir,
        }),
      )
      const detail = observed.detail
      evidence.push(observed.evidence)
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
    }
    rounds.push(details)
    roundDurationsMs.push(Date.now() - startedAt)
  }

  const report = buildReport({
    model: 'p7-simulation',
    promptVersion: PROMPT_VERSION,
    rounds,
    repeat: options.repeat,
    roundDurationsMs,
    cases,
    level: 'L2',
    userModel: 'p7-simulation-simulator',
    judgeModel: 'p7-simulation-judge',
  })
  // 当前套件只接受模拟传输 不将确定性回放包装成统计采样区间
  report.confidenceIntervals = undefined
  if (options.budget.signal?.aborted || evidence.length !== cases.length * options.repeat)
    report.gatePassed = false
  return suiteEvidence(options.budget, report, evidence, metadata)
}
