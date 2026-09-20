/**
 * 导出评测数据集为 JSON
 *
 * 用法 pnpm eval:dataset
 * 输出 eval/dataset/dataset.json 作为公开数据集样例
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EVAL_CASES, casePrioritySummary } from '@aftersales/eval'

const outputDir = resolve(process.cwd(), 'eval', 'dataset')
mkdirSync(outputDir, { recursive: true })
const outputPath = resolve(outputDir, 'dataset.json')

const payload = {
  exportedAt: new Date().toISOString(),
  caseCount: EVAL_CASES.length,
  prioritySummary: casePrioritySummary(),
  cases: EVAL_CASES,
}

writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf-8')
console.log(`数据集已导出 ${outputPath} 共 ${EVAL_CASES.length} 条用例`)
console.log('优先级分布', JSON.stringify(casePrioritySummary()))
