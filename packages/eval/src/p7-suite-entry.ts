import type { EvalCase, EvalReport } from '@aftersales/contracts'
import { PROMPT_VERSION, ACTION_TOOLS, buildStepTools, type ChatModel } from '@aftersales/agent'
import { P7Error } from '@aftersales/contracts'
import { P7Ledger, type SqliteDatabase } from '@aftersales/persistence'
import { createP7EvalModels, type P7EvalModelsInput } from './p7-eval-models.js'
import { readP7CostReport, type P7CostReport } from './p7-cost-report.js'
import { runCase } from './runner.js'
import { buildReport } from './report.js'
import type { CaseDetail } from './types.js'
import { redactEvidence, type BusinessEvidence } from './p9-evidence.js'
import { evaluationMetadata, type P9Metadata } from './p9-metadata.js'

export interface P7SuiteBudget {
  db: SqliteDatabase
  experimentId: string
  /** 受信配置解析器 用例覆盖必须由此显式解析 禁止构造裸模型 */
  roles(testCase: EvalCase, repeat?: number): P7EvalModelsInput['roles']
  signal?: AbortSignal
}
export interface P7CaseEvidence {
  identity: P7EvalModelsInput['identity']
  modelRunIds: Readonly<Partial<Record<'main_agent' | 'simulator' | 'judge', string>>>
  businessRunId: string | null
  passed: boolean
  failures: CaseDetail['failures']
  business?: BusinessEvidence | null
  modelCalls?: ModelObservation[]
  configurations?: Record<string, unknown>
}

// 装配或服务失败仍产生计划内用例记录 不重跑业务链
export async function executeBudgetedCase(
  budget: P7SuiteBudget,
  testCase: EvalCase,
  repeat: number,
  ledger: P7Ledger,
  execute: (models: ReturnType<typeof suiteModels>) => Promise<CaseDetail>,
): Promise<{ detail: CaseDetail; evidence: P7CaseEvidence }> {
  let models: ReturnType<typeof suiteModels> | undefined
  let detail: CaseDetail
  try {
    models = suiteModels(budget, testCase, repeat, ledger)
    detail = await execute(models)
    applyModelFailures(detail, models.errors)
  } catch (error) {
    detail = {
      caseId: testCase.id,
      category: testCase.category,
      priority: testCase.priority,
      passed: false,
      durationMs: 0,
      failures: [
        {
          kind: 'exception',
          message: error instanceof P7Error ? error.code : 'SERVICE_SETUP_FAILED',
        },
      ],
      layer: {
        stateOk: false,
        trajectoryOk: false,
        argsOk: false,
        escalationOk: false,
        clarifyOk: false,
        gatewayOk: false,
      },
    }
  }
  return {
    detail,
    evidence: {
      identity: { experimentId: budget.experimentId, caseId: testCase.id, repeat },
      modelRunIds: models?.runIds ?? {},
      businessRunId: detail.runId ?? null,
      passed: detail.passed,
      failures: detail.failures,
      business: detail.evidence ?? null,
      modelCalls: models?.observations ?? [],
      configurations: models?.configurations,
    },
  }
}
export interface ModelObservation {
  runId: string
  callRound: number
  request: unknown
  events: unknown[]
  error: string | null
}
export interface P7SuiteResult {
  report: EvalReport
  evidence: {
    mode: 'simulation'
    experimentId: string
    cases: P7CaseEvidence[]
    costs: P7CostReport
    metadata?: P9Metadata
  }
}

/** 每个用例实例只创建一次 身份重用交由账本拒绝 不读取最大序号续跑 */
export function suiteModels(
  budget: P7SuiteBudget,
  testCase: EvalCase,
  repeat: number,
  ledger: P7Ledger,
) {
  const configurations = budget.roles(testCase, repeat)
  const models = createP7EvalModels({
    identity: { experimentId: budget.experimentId, caseId: testCase.id, repeat },
    ledger,
    roles: configurations,
    signal: budget.signal,
  })
  const errors: string[] = []
  const observations: ModelObservation[] = []
  const track = (model: ChatModel, runId: string): ChatModel => {
    let round = 0
    return {
      info: model.info,
      supportsCancellation: model.supportsCancellation,
      async *stream(request, signal) {
        const observation: ModelObservation = {
          runId,
          callRound: ++round,
          request: structuredClone(request),
          events: [],
          error: null,
        }
        observations.push(observation)
        try {
          for await (const event of model.stream(request, signal)) {
            observation.events.push(structuredClone(event))
            yield event
          }
        } catch (error) {
          const code = error instanceof P7Error ? error.code : 'MODEL_CALL_FAILED'
          observation.error = code
          errors.push(runId === models.runIds.judge ? `JUDGE ${code}` : code)
          throw error
        }
      },
    }
  }
  return {
    ...models,
    errors,
    observations,
    configurations: redactEvidence(
      Object.fromEntries(
        Object.entries(configurations).map(([role, config]) => [role, config.snapshot]),
      ),
    ),
    agentModel: track(models.agentModel, models.runIds.main_agent),
    userModel: track(models.userModel, models.runIds.simulator),
    judgeModel: track(models.judgeModel, models.runIds.judge),
  }
}

/** 消费者捕获模型异常也不能把没有执行的调用记为成功 */
export function applyModelFailures(detail: CaseDetail, errors: string[]): void {
  if (!errors.length) return
  detail.passed = false
  if (errors.some((code) => !code.startsWith('JUDGE '))) detail.layer.stateOk = false
  for (const code of errors)
    detail.failures.push({
      kind: code.startsWith('JUDGE ') ? 'judge' : 'exception',
      message: `P7 模型调用未完成 ${code}`,
    })
}

export function suiteEvidence(
  budget: P7SuiteBudget,
  report: EvalReport,
  cases: P7CaseEvidence[],
  metadata?: P9Metadata,
): P7SuiteResult {
  // 保存失败明细以区分无账本行的调用拒绝和未执行 不从零行推断免费成功
  if (cases.some((item) => item.failures.some((failure) => failure.kind === 'exception')))
    report.gatePassed = false
  const filtered = redactEvidence({ report, cases })
  return {
    report: filtered.report,
    evidence: {
      mode: 'simulation',
      experimentId: budget.experimentId,
      cases: filtered.cases,
      metadata,
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
  const metadata = evaluationMetadata(cases, repeat, 'L1')
  const rounds: CaseDetail[][] = []
  const durations: number[] = []
  const evidence: P7CaseEvidence[] = []
  const ledger = new P7Ledger(budget.db)
  for (let round = 1; round <= repeat; round++) {
    const started = Date.now()
    const details: CaseDetail[] = []
    for (const testCase of cases) {
      const observed = await executeBudgetedCase(budget, testCase, round, ledger, (models) => {
        // 完整工具目录只用于离线弱模型领域防线回放
        const replayModel: ChatModel = {
          info: models.agentModel.info,
          stream: (request) =>
            models.agentModel.stream({
              ...request,
              tools: buildStepTools({ actions: ACTION_TOOLS }),
            }),
        }
        return runCase(testCase, { model: replayModel })
      })
      details.push(observed.detail)
      evidence.push(observed.evidence)
    }
    rounds.push(details)
    durations.push(Date.now() - started)
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
  return suiteEvidence(budget, report, evidence, metadata)
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
