import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EvalReport } from '@aftersales/contracts'
import type { P7CaseEvidence, P7SuiteResult } from './p7-suite-entry.js'
import { contentHash, evidencePath } from './p9-metadata.js'
import { redactEvidence } from './p9-evidence.js'

export type FailureClass =
  | 'business_assertion'
  | 'model_protocol'
  | 'service_exception'
  | 'timeout_cancel'
  | 'budget_blocked'
  | 'evidence_missing'
  | 'judge_failure'

// 分类可多选 保留业务失败与基础设施失败同时发生的事实
export function failureClasses(item: P7CaseEvidence): FailureClass[] {
  const classes = new Set<FailureClass>()
  if (!item.business || !item.businessRunId || !item.business.runs.length)
    classes.add('evidence_missing')
  for (const failure of item.failures) {
    if (failure.kind === 'judge') classes.add('judge_failure')
    else if (failure.kind !== 'exception') classes.add('business_assertion')
    else if (/BUDGET_EXCEEDED|CONCURRENCY|PRICE_MISSING/.test(failure.message))
      classes.add('budget_blocked')
    else if (/TIMEOUT|CANCELLED|AbortError/.test(failure.message)) classes.add('timeout_cancel')
    else if (/PROTOCOL|TRUNCATED|EMPTY|USAGE_MISSING/.test(failure.message))
      classes.add('model_protocol')
    else classes.add('service_exception')
  }
  return [...classes]
}

const key = (item: P7CaseEvidence) => JSON.stringify([item.identity.caseId, item.identity.repeat])

export function qualitySummary(cases: P7CaseEvidence[]) {
  const scored = cases.filter(
    (item) =>
      !failureClasses(item).some((kind) =>
        [
          'service_exception',
          'timeout_cancel',
          'budget_blocked',
          'model_protocol',
          'evidence_missing',
        ].includes(kind),
      ),
  )
  const businessPassed = scored.filter(
    (item) => !item.failures.some((failure) => failure.kind !== 'judge'),
  ).length
  return {
    endToEnd: {
      passed: cases.filter((item) => item.passed && !failureClasses(item).length).length,
      total: cases.length,
    },
    business: { passed: businessPassed, total: cases.length, scorable: scored.length },
    subjective: {
      passed: scored.filter(
        (item) =>
          !item.failures.some((failure) => failure.kind === 'judge') &&
          item.modelCalls?.some((call) => JSON.parse(call.runId)[4] === 'judge'),
      ).length,
      total: scored.filter((item) =>
        item.modelCalls?.some((call) => JSON.parse(call.runId)[4] === 'judge'),
      ).length,
    },
    failureClasses: Object.fromEntries(
      (
        [
          'business_assertion',
          'model_protocol',
          'service_exception',
          'timeout_cancel',
          'budget_blocked',
          'evidence_missing',
          'judge_failure',
        ] as const
      ).map((kind) => [kind, cases.filter((item) => failureClasses(item).includes(kind)).length]),
    ),
  }
}

// 附件沿用原报告和账本 逐用例文件是原始证据的稳定定位
export function exportQualityBundle(
  directory: string,
  result: P7SuiteResult,
  intervention = 'none',
) {
  if (!result.evidence.metadata) throw new Error('缺少 P9 元数据')
  mkdirSync(resolve(directory, 'cases'), { recursive: true })
  const filtered = redactEvidence({ report: result.report, cases: result.evidence.cases })
  const safe = { report: filtered.report, evidence: { ...result.evidence, cases: filtered.cases } }
  const references = safe.evidence.cases.map((item, index) => {
    const file = `cases/${index + 1}.json`
    writeFileSync(evidencePath(directory, file), JSON.stringify(item, null, 2))
    return {
      key: key(item),
      file,
      hash: contentHash(item),
      passed: item.passed,
      classes: failureClasses(item),
    }
  })
  const bundle = {
    schemaVersion: 1 as const,
    intervention,
    report: safe.report,
    metadata: safe.evidence.metadata!,
    experimentId: safe.evidence.experimentId,
    costs: safe.evidence.costs,
    references,
    summary: qualitySummary(safe.evidence.cases),
    limitations:
      '确定性离线协议机制验证 不代表真实模型质量或随机稳定性 Judge 尚未校准 费用仅模拟账本观察',
  }
  writeFileSync(resolve(directory, 'quality.json'), JSON.stringify(bundle, null, 2))
  writeFileSync(
    resolve(directory, 'failures.json'),
    JSON.stringify(
      references.filter((item) => !item.passed || item.classes.length),
      null,
      2,
    ),
  )
  writeFileSync(
    resolve(directory, 'quality.md'),
    [
      '# P9 离线质量报告',
      '',
      `实验 ${bundle.experimentId} 报告 ${bundle.report.reportId}`,
      `端到端 ${bundle.summary.endToEnd.passed}/${bundle.summary.endToEnd.total} 业务 ${bundle.summary.business.passed}/${bundle.summary.business.total} 可评分 ${bundle.summary.business.scorable}`,
      `模拟费用 ${bundle.costs.currency} ${bundle.costs.unit} ${JSON.stringify(bundle.costs.selection.summary)}`,
      `共享 scope ${JSON.stringify(bundle.costs.scopeSummary)} 无记录不代表零成本`,
      bundle.limitations,
      '',
      ...references.map(
        (item) =>
          `- ${item.key} ${item.passed && !item.classes.length ? '通过' : '失败'} ${item.classes.join(' ')} [原始证据](${item.file})`,
      ),
    ].join('\n'),
  )
  verifyQualityBundle(directory)
  return bundle
}

export interface QualityBundle {
  schemaVersion: 1
  intervention: string
  report: P7SuiteResult['report']
  metadata: NonNullable<P7SuiteResult['evidence']['metadata']>
  experimentId: string
  costs: P7SuiteResult['evidence']['costs']
  references: Array<{
    key: string
    file: string
    hash: string
    passed: boolean
    classes: FailureClass[]
  }>
  summary: ReturnType<typeof qualitySummary>
  limitations: string
}

// 验证真实文件与业务运行及模型账本关联 不以字段存在代替证据
export function verifyQualityBundle(directory: string) {
  const bundle = JSON.parse(
    readFileSync(resolve(directory, 'quality.json'), 'utf8'),
  ) as QualityBundle
  EvalReport.parse(bundle.report)
  if (bundle.schemaVersion !== 1 || bundle.metadata.metricVersion !== 'p9-v1')
    throw new Error('未知报告版本')
  if (
    contentHash(bundle.metadata.selectedCases) !== bundle.metadata.selectedHash ||
    contentHash(bundle.metadata.source.files) !== bundle.metadata.source.hash
  )
    throw new Error('元数据哈希不符')
  const expected = Array.from({ length: bundle.metadata.repeat }, (_, index) =>
    bundle.metadata.caseOrder.map((caseId) => JSON.stringify([caseId, index + 1])),
  ).flat()
  if (
    new Set(expected).size !== expected.length ||
    contentHash(bundle.references.map((ref) => ref.key)) !== contentHash(expected)
  )
    throw new Error('缺失重复或乱序用例证据')
  const cases = bundle.references.map((ref, index) => {
    const item = JSON.parse(
      readFileSync(evidencePath(directory, ref.file), 'utf8'),
    ) as P7CaseEvidence
    if (
      contentHash(item) !== ref.hash ||
      key(item) !== ref.key ||
      item.identity.experimentId !== bundle.experimentId
    )
      throw new Error('证据内容或身份不符')
    if (
      ref.passed !== item.passed ||
      contentHash(ref.classes) !== contentHash(failureClasses(item))
    )
      throw new Error('引用判定或失败分类与原始证据不符')
    const detail = bundle.report.caseResults[index]
    if (
      !detail ||
      detail.caseId !== item.identity.caseId ||
      detail.repeat !== item.identity.repeat ||
      detail.passed !== item.passed ||
      contentHash(detail.failures) !== contentHash(item.failures)
    )
      throw new Error('报告与证据判定不符')
    if (item.passed && failureClasses(item).length) throw new Error('成功判定缺少证据或包含失败')
    if (
      item.business &&
      (item.business.runId !== item.businessRunId ||
        item.business.runs.some((run) => run.run_id !== item.businessRunId) ||
        item.business.events.some((event) => event.run_id !== item.businessRunId))
    )
      throw new Error('业务证据运行错配')
    if (item.business) {
      const testCase = bundle.metadata.selectedCases.find(
        (selected) => selected.id === item.identity.caseId,
      )
      const assertions = testCase?.assertions.expectedState.filter(
        (assertion) => !assertion.level || assertion.level === bundle.metadata.level,
      )
      if (
        !assertions ||
        contentHash(assertions) !==
          contentHash(item.business.assertions.map((entry) => entry.assertion))
      )
        throw new Error('断言证据缺失或重复')
      const sequences = item.business.events.map((event) => event.sequence)
      if (new Set(sequences).size !== sequences.length) throw new Error('重复业务事件证据')
    }
    for (const [role, runId] of Object.entries(item.modelRunIds)) {
      if (
        runId !==
        JSON.stringify([
          'p7-eval-v1',
          bundle.experimentId,
          item.identity.caseId,
          item.identity.repeat,
          role,
        ])
      )
        throw new Error('角色运行身份不符')
    }
    const calls = item.modelCalls ?? []
    if (
      new Set(calls.map((call) => JSON.stringify([call.runId, call.callRound]))).size !==
      calls.length
    )
      throw new Error('重复模型调用证据')
    for (const call of calls) {
      if (!Object.values(item.modelRunIds).includes(call.runId)) throw new Error('模型原文运行错配')
      const ledger = bundle.costs.calls.filter(
        (row) => row.runId === call.runId && row.attribution.callRound === call.callRound,
      )
      if (!ledger.length && !call.error) throw new Error('成功调用缺少费用证据')
    }
    for (const row of bundle.costs.calls.filter((call) =>
      Object.values(item.modelRunIds).includes(call.runId),
    )) {
      if (
        row.attribution.kind !== 'eval' ||
        !calls.some(
          (call) => call.runId === row.runId && call.callRound === row.attribution.callRound,
        )
      )
        throw new Error('账本缺少模型原文证据')
    }
    return item
  })
  if (
    bundle.report.caseResults.length !== cases.length ||
    contentHash(qualitySummary(cases)) !== contentHash(bundle.summary)
  )
    throw new Error('报告分母或统计不符')
  if (
    bundle.report.total !== cases.length ||
    bundle.report.passed !== cases.filter((item) => item.passed).length ||
    bundle.report.failed !== cases.filter((item) => !item.passed).length
  )
    throw new Error('报告计数不符')
  // 原始用例校验后重算失败索引 防止摘要丢失或重复失败
  const expectedFailures = bundle.references.filter(
    (_, index) => !cases[index]!.passed || failureClasses(cases[index]!).length > 0,
  )
  const failures: unknown = JSON.parse(readFileSync(resolve(directory, 'failures.json'), 'utf8'))
  if (contentHash(failures) !== contentHash(expectedFailures))
    throw new Error('失败索引缺失重复或与原始证据不符')
  return { bundle, cases }
}

export type ExperimentVariable = 'model' | 'prompt' | 'fault'

// 不可比报告不产生差值 避免对不同样本给出提升结论
export function compareQualityBundles(
  leftDirectory: string,
  rightDirectory: string,
  variables: ExperimentVariable[] = [],
) {
  const left = verifyQualityBundle(leftDirectory)
  const right = verifyQualityBundle(rightDirectory)
  const reasons: string[] = []
  for (const field of [
    'mode',
    'level',
    'datasetHash',
    'selectedHash',
    'caseOrder',
    'repeat',
    'policyVersion',
    'knowledgeHash',
    'fixtureHash',
    'metricVersion',
  ] as const)
    if (contentHash(left.bundle.metadata[field]) !== contentHash(right.bundle.metadata[field]))
      reasons.push(`${field} 不同`)
  if (left.bundle.metadata.source.hash !== right.bundle.metadata.source.hash)
    reasons.push('受控源码内容不同')
  if (left.bundle.intervention !== right.bundle.intervention && !variables.includes('fault'))
    reasons.push('故障变量未声明')
  const config = (cases: P7CaseEvidence[]) =>
    cases.map((item) =>
      Object.fromEntries(
        Object.entries(item.configurations ?? {}).map(([role, snapshot]) => {
          const value = { ...(snapshot as Record<string, unknown>) }
          if (variables.includes('model') || variables.includes('prompt')) delete value.version
          if (variables.includes('model')) delete value.model
          if (variables.includes('prompt')) delete value.promptVersion
          return [role, value]
        }),
      ),
    )
  if (
    left.cases.some((item) => !item.configurations) ||
    right.cases.some((item) => !item.configurations) ||
    contentHash(config(left.cases)) !== contentHash(config(right.cases))
  )
    reasons.push('模型或提示词及运行配置不同且未声明')
  if (
    left.bundle.costs.currency !== right.bundle.costs.currency ||
    left.bundle.costs.unit !== right.bundle.costs.unit
  )
    reasons.push('费用币种单位不同')
  if (reasons.length) return { comparable: false as const, reasons, variables, differences: null }
  const failed = (item: P7CaseEvidence) => !item.passed || failureClasses(item).length > 0
  const changes = {
    newFailures: [] as string[],
    fixedFailures: [] as string[],
    persistentFailures: [] as string[],
  }
  left.cases.forEach((item, index) => {
    const next = right.cases[index]!
    if (!failed(item) && failed(next)) changes.newFailures.push(key(item))
    if (failed(item) && !failed(next)) changes.fixedFailures.push(key(item))
    if (failed(item) && failed(next)) changes.persistentFailures.push(key(item))
  })
  const before = left.bundle.costs.selection.summary
  const after = right.bundle.costs.selection.summary
  return {
    comparable: true as const,
    reasons,
    variables,
    differences: {
      ...changes,
      before: left.bundle.summary,
      after: right.bundle.summary,
      simulationCost: {
        currency: left.bundle.costs.currency,
        unit: left.bundle.costs.unit,
        before,
        after,
        settledDelta:
          before.observation === 'no_recorded_calls' || after.observation === 'no_recorded_calls'
            ? null
            : after.settled.actual - before.settled.actual,
        unknownReservedDelta: after.unknown.reserved - before.unknown.reserved,
        heldReservedDelta: after.held.reserved - before.held.reserved,
        actualTotalDelta:
          before.hasUncertainCost ||
          after.hasUncertainCost ||
          before.observation === 'no_recorded_calls' ||
          after.observation === 'no_recorded_calls'
            ? null
            : after.settled.actual - before.settled.actual,
      },
      conclusion: '仅比较确定性离线机制 不给出真实质量提升结论 不合并两份报告分母',
    },
  }
}
