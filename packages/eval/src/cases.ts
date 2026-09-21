/**
 * 评测数据集
 *
 * 九类风险面（八类调研风险面 + 补偿新能力）用例合集
 * 扩展指引见 docs/evaluation.md 每条用例必须满足任务契约完整性
 */

import type { EvalCase, EvalCaseInput } from '@aftersales/contracts'
import { EvalCase as EvalCaseSchema } from '@aftersales/contracts'
import { happyPathCases } from './cases/happy-path.js'
import { clarificationCases } from './cases/clarification.js'
import { policyBoundaryCases } from './cases/policy-boundary.js'
import { approvalCases } from './cases/approval.js'
import { rejectionCases } from './cases/rejection.js'
import { faultInjectionCases } from './cases/fault-injection.js'
import { securityCases } from './cases/security.js'
import { recoveryCases } from './cases/recovery.js'
import { compensationCases } from './cases/compensation.js'
import { logisticsCases } from './cases/logistics.js'
import { priceProtectionCases } from './cases/price-protection.js'
import { policyRagCases } from './cases/policy-rag.js'
import { simHardCases } from './cases/sim-hard.js'

/** 全部用例 载入时做契约校验 数据不合法直接失败 */
export const EVAL_CASES: EvalCase[] = validateCases([
  ...happyPathCases,
  ...clarificationCases,
  ...policyBoundaryCases,
  ...approvalCases,
  ...rejectionCases,
  ...faultInjectionCases,
  ...securityCases,
  ...recoveryCases,
  ...compensationCases,
  ...logisticsCases,
  ...priceProtectionCases,
  ...policyRagCases,
  ...simHardCases,
])

/** 带 scenario 的用例 可执行 L2 用户模拟评测 */
export const SIM_CASES: EvalCase[] = EVAL_CASES.filter((testCase) => testCase.scenario !== undefined)

function validateCases(input: readonly EvalCaseInput[]): EvalCase[] {
  const seen = new Set<string>()
  const result: EvalCase[] = []
  for (const testCase of input) {
    if (seen.has(testCase.id)) {
      throw new Error(`评测用例编号重复 ${testCase.id}`)
    }
    seen.add(testCase.id)
    const parsed = EvalCaseSchema.safeParse(testCase)
    if (!parsed.success) {
      throw new Error(
        `评测用例 ${testCase.id} 不符合契约 ${parsed.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).join(', ')}`,
      )
    }
    result.push(parsed.data)
  }
  return result
}

/** 按优先级统计 */
export function casePrioritySummary(): Record<string, number> {
  const summary: Record<string, number> = { P0: 0, P1: 0, P2: 0 }
  for (const testCase of EVAL_CASES) {
    summary[testCase.priority] = (summary[testCase.priority] ?? 0) + 1
  }
  return summary
}
