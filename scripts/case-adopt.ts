/**
 * 将草稿采纳为 regression 用例
 *
 * 用法 pnpm case:adopt -- --draft <file> --id <caseId> [--priority P1]
 * 必须显式指定 id 禁止自动入库
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EvalCase, type EvalCaseInput } from '@aftersales/contracts'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`参数 ${name} 缺少值`)
  return value
}

const draftPath = arg('--draft')
const caseId = arg('--id')
if (!draftPath || !caseId) {
  console.error('用法 pnpm case:adopt -- --draft <file> --id <caseId> [--priority P0|P1|P2]')
  process.exit(1)
}
if (!/^[a-z][a-z0-9_]{2,80}$/.test(caseId)) {
  console.error('用例编号须为小写字母开头的标识')
  process.exit(1)
}

const raw = JSON.parse(readFileSync(resolve(draftPath), 'utf-8')) as {
  meta?: unknown
  case?: EvalCaseInput
}
if (!raw.case) {
  console.error('草稿缺少 case 字段')
  process.exit(1)
}

const priority = arg('--priority') ?? raw.case.priority ?? 'P1'
if (priority !== 'P0' && priority !== 'P1' && priority !== 'P2') {
  console.error('priority 只允许 P0 P1 P2')
  process.exit(1)
}

const nextCase: EvalCaseInput = {
  ...raw.case,
  id: caseId,
  category: 'regression',
  priority,
}
const parsed = EvalCase.safeParse(nextCase)
if (!parsed.success) {
  console.error(`用例不符合契约 ${parsed.error.message}`)
  process.exit(1)
}

const directory = resolve('eval/cases/regression')
mkdirSync(directory, { recursive: true })
const target = resolve(directory, `${caseId}.json`)
if (existsSync(target) && !process.argv.includes('--force')) {
  console.error(`用例已存在 ${target} 如需覆盖请加 --force`)
  process.exit(1)
}
writeFileSync(target, JSON.stringify(parsed.data, null, 2), 'utf-8')
console.log(`已采纳 ${target}`)
console.log('请运行 pnpm eval -- --case', caseId)
