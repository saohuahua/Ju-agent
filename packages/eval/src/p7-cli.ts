import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { openDatabase, saveEvalReport } from '@aftersales/persistence'
import { EVAL_CASES } from './cases.js'
import { runBudgetedL1, saveP7EvalEvidence } from './p7-suite-entry.js'
import { offlineEvalRoles } from './p7-offline-roles.js'
import { runSimSuite } from './sim-suite.js'
import { renderMarkdownReport } from './report.js'

/** 不读取环境密钥 默认独立评测库跨实验保留累计预算 */
export async function runEvalCli(level: 'L1' | 'L2'): Promise<void> {
  let repeat = 1
  let experimentId = `eval-${randomUUID()}`
  let dbPath = 'data/eval-p7.db'
  let output = 'eval/reports'
  let caseId: string | undefined
  let category: string | undefined
  let sample: 'p0' | 'p1' | 'p2' | 'all' = 'p0'
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (key === '--' || key === '--offline' || key === '--gate') continue
    const value = args[++index]
    if (!value) throw new Error(`参数 ${key} 缺少值`)
    if (key === '--repeat') repeat = Number(value)
    else if (key === '--experiment-id') experimentId = value
    else if (key === '--db') dbPath = value
    else if (key === '--output') output = value
    else if (key === '--case') caseId = value
    else if (key === '--category') category = value
    else if (key === '--sample' && ['p0', 'p1', 'p2', 'all'].includes(value))
      sample = value as typeof sample
    else if (key === '--model' && ['scripted', 'offline'].includes(value)) continue
    else throw new Error(`不支持参数 ${key} 或真实模型配置 仅允许离线预算评测`)
  }
  if (!experimentId.trim()) throw new Error('实验标识不能为空')
  const db = openDatabase(resolve(dbPath))
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('评测已取消'))
  process.once('SIGINT', cancel)
  try {
    const started = Date.now()
    const budget = { db, experimentId, roles: offlineEvalRoles, signal: controller.signal }
    const cases = EVAL_CASES.filter((item) =>
      caseId ? item.id === caseId : !category || item.category === category,
    )
    if (!cases.length) throw new Error('用例不存在')
    const result =
      level === 'L1'
        ? await runBudgetedL1(cases, repeat, budget)
        : await runSimSuite({
            budget,
            repeat,
            sample,
            caseId,
            category,
            agentModel: 'offline-main_agent',
            userModel: 'offline-simulator',
            judgeModel: 'offline-judge',
          })
    const { report, evidence } = result
    db.transaction(() => {
      saveEvalReport(db, { ...report, report })
      saveP7EvalEvidence(db, result)
    }).immediate()
    const directory = resolve(output)
    mkdirSync(directory, { recursive: true })
    writeFileSync(resolve(directory, `${report.reportId}.json`), JSON.stringify(report, null, 2))
    writeFileSync(
      resolve(directory, `${report.reportId}.evidence.json`),
      JSON.stringify(evidence, null, 2),
    )
    writeFileSync(
      resolve(directory, `${report.reportId}.md`),
      renderMarkdownReport(report, { repeat, durationMs: Date.now() - started }) +
        `\n\n离线模拟验收 不代表真实模型质量或供应商费用\n\n实验 ${experimentId}\n\n费用与身份附件 ${report.reportId}.evidence.json\n`,
    )
    console.log(
      JSON.stringify({
        reportId: report.reportId,
        experimentId,
        mode: 'simulation',
        total: report.total,
        passed: report.passed,
        gatePassed: report.gatePassed,
        costUnit: evidence.costs.unit,
        scopeCommitted: evidence.costs.scopeSummary.committed,
        hasUncertainCost: evidence.costs.scopeSummary.hasUncertainCost,
        blocked: evidence.costs.budget.blocked,
        output: directory,
      }),
    )
    if (!report.gatePassed) process.exitCode = 1
  } finally {
    process.removeListener('SIGINT', cancel)
    db.close()
  }
}
