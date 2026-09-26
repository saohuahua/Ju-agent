import type { EvalCase, EvalReport } from '@aftersales/contracts'
import { PROMPT_VERSION, ACTION_TOOLS, buildStepTools, type ChatModel } from '@aftersales/agent'
import { P7Error } from '@aftersales/contracts'
import { P7Ledger, type SqliteDatabase } from '@aftersales/persistence'
import { createP7EvalModels, type P7EvalModelsInput } from './p7-eval-models.js'
import { readP7CostReport, type P7CostReport } from './p7-cost-report.js'
import { runCase } from './runner.js'
import { buildReport } from './report.js'
import type { CaseDetail } from './types.js'

export interface P7SuiteBudget {
  db: SqliteDatabase
  experimentId: string
  /** 受信配置解析器 用例覆盖必须由此显式解析 禁止构造裸模型 */
  roles(testCase: EvalCase): P7EvalModelsInput['roles']
  signal?: AbortSignal
}
export interface P7CaseEvidence {
  identity: P7EvalModelsInput['identity']
  modelRunIds: Readonly<Record<'main_agent' | 'simulator' | 'judge', string>>
  businessRunId: string | null
  passed: boolean
  failures: CaseDetail['failures']
}
export interface P7SuiteResult {
  report: EvalReport
  evidence: {
    mode: 'simulation'
    experimentId: string
    cases: P7CaseEvidence[]
    costs: P7CostReport
  }
}

/** 每个用例实例只创建一次 身份重用交由账本拒绝 不读取最大序号续跑 */
export function suiteModels(
  budget: P7SuiteBudget,
  testCase: EvalCase,
  repeat: number,
  ledger: P7Ledger,
) {
  budget.signal?.throwIfAborted()
  const models = createP7EvalModels({
    identity: { experimentId: budget.experimentId, caseId: testCase.id, repeat },
    ledger,
    roles: budget.roles(testCase),
    signal: budget.signal,
  })
  const errors: string[] = []
  const track = (model: ChatModel): ChatModel => ({
    info: model.info,
    supportsCancellation: model.supportsCancellation,
    async *stream(request, signal) {
      try {
        yield* model.stream(request, signal)
      } catch (error) {
        errors.push(error instanceof P7Error ? error.code : 'MODEL_CALL_FAILED')
        throw error
      }
    },
  })
  return {
    ...models,
    errors,
    agentModel: track(models.agentModel),
    userModel: track(models.userModel),
    judgeModel: track(models.judgeModel),
  }
}

/** 消费者捕获模型异常也不能把没有执行的调用记为成功 */
export function applyModelFailures(detail: CaseDetail, errors: string[]): void {
  if (!errors.length) return
  detail.passed = false
  detail.layer.stateOk = false
  for (const code of errors)
    detail.failures.push({ kind: 'exception', message: `P7 模型调用未完成 ${code}` })
}

export function suiteEvidence(
  budget: P7SuiteBudget,
  report: EvalReport,
  cases: P7CaseEvidence[],
): P7SuiteResult {
  // 保存失败明细以区分无账本行的调用拒绝和未执行 不从零行推断免费成功
  if (cases.some((item) => item.failures.some((failure) => failure.kind === 'exception')))
    report.gatePassed = false
  return {
    report,
    evidence: {
      mode: 'simulation',
      experimentId: budget.experimentId,
      cases,
      costs: readP7CostReport(budget.db, {
        scope: 'simulation:first-real-cny-100',
        experimentId: budget.experimentId,
      }),
    },
  }
}

export async function runBudgetedL1(
  cases: EvalCase[],
  repeat: number,
  budget: P7SuiteBudget,
): Promise<P7SuiteResult> {
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20)
    throw new Error('重复轮次须为一至二十的整数')
  const rounds: CaseDetail[][] = []
  const durations: number[] = []
  const evidence: P7CaseEvidence[] = []
  const ledger = new P7Ledger(budget.db)
  for (let round = 1; round <= repeat; round++) {
    const started = Date.now()
    const details: CaseDetail[] = []
    for (const testCase of cases) {
      const models = suiteModels(budget, testCase, round, ledger)
      // L1 弱模型脚本刻意越过目录门控测试领域防线 完整目录只用于本地回放
      // L2 保持原动态工具目录 所有真实模型模式仍由网关拒绝
      const replayModel: ChatModel = {
        info: models.agentModel.info,
        stream: (request) =>
          models.agentModel.stream({
            ...request,
            tools: buildStepTools({ actions: ACTION_TOOLS }),
          }),
      }
      const detail = await runCase(testCase, { model: replayModel })
      applyModelFailures(detail, models.errors)
      details.push(detail)
      evidence.push({
        identity: models.identity,
        modelRunIds: models.runIds,
        businessRunId: detail.runId ?? null,
        passed: detail.passed,
        failures: detail.failures,
      })
      if (budget.signal?.aborted) break
    }
    rounds.push(details)
    durations.push(Date.now() - started)
    if (budget.signal?.aborted) break
  }
  const report = buildReport({
    model: 'p7-offline-scripted',
    promptVersion: PROMPT_VERSION,
    rounds,
    repeat,
    roundDurationsMs: durations,
    cases,
  })
  if (budget.signal?.aborted || evidence.length !== cases.length * repeat) report.gatePassed = false
  return suiteEvidence(budget, report, evidence)
}

/** 附件单独保存 不修改原报告 DTO 或美元金额字段 */
export function saveP7EvalEvidence(db: SqliteDatabase, result: P7SuiteResult): void {
  db.prepare(
    'INSERT INTO eval_budget_evidence(report_id,experiment_id,evidence_json) VALUES (?,?,?)',
  ).run(result.report.reportId, result.evidence.experimentId, JSON.stringify(result.evidence))
}

export function readP7EvalEvidence(
  db: SqliteDatabase,
  reportId: string,
): P7SuiteResult['evidence'] | null {
  const row = db
    .prepare('SELECT evidence_json AS value FROM eval_budget_evidence WHERE report_id = ?')
    .get(reportId) as { value: string } | undefined
  return row ? (JSON.parse(row.value) as P7SuiteResult['evidence']) : null
}
