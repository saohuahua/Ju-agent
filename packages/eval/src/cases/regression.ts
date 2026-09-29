/**
 * 由历史会话采纳的回归用例
 *
 * 文件位于仓库 eval/cases/regression 载入时做契约校验
 * 目录为空时本分类贡献零条 不改变原 124 条基数
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EvalCaseInput } from '@aftersales/contracts'

const directory = join(dirname(fileURLToPath(import.meta.url)), '../../../../eval/cases/regression')

function loadRegressionFiles(): EvalCaseInput[] {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const cases: EvalCaseInput[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const parsed = JSON.parse(readFileSync(join(directory, name), 'utf-8')) as EvalCaseInput
    cases.push(parsed)
  }
  return cases
}

export const regressionCases: EvalCaseInput[] = loadRegressionFiles()
