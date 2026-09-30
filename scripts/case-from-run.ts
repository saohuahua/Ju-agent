/**
 * 从历史会话生成 L1 用例草稿
 *
 * 用法 pnpm case:from-run -- --run <runId> [--db path] [--out file]
 * 只写 eval/traces 不改评测集
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { extractCaseDraft } from '@aftersales/eval'
import {
  openDatabase,
  SqliteAgentRunRepository,
  SqliteEventRepository,
} from '@aftersales/persistence'
import { EvalCase } from '@aftersales/contracts'
import { businessPath } from './local-offline-paths.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`参数 ${name} 缺少值`)
  return value
}

const runId = arg('--run')
if (!runId) {
  console.error('用法 pnpm case:from-run -- --run <runId> [--db path] [--out file]')
  process.exit(1)
}

const db = openDatabase(resolve(arg('--db') ?? businessPath))
try {
  const run = await new SqliteAgentRunRepository(db).findById(runId)
  if (!run) {
    console.error(`运行不存在 ${runId}`)
    process.exit(1)
  }
  const events = await new SqliteEventRepository(db).listByRun(runId)
  const draft = extractCaseDraft(
    {
      runId: run.runId,
      customerId: run.customerId,
      status: run.status,
      promptVersion: run.promptVersion,
      model: run.model,
      source: run.source,
      createdAt: run.createdAt,
    },
    events,
  )
  const parsed = EvalCase.safeParse(draft.case)
  if (!parsed.success) {
    console.error(`草稿不符合用例契约 ${parsed.error.message}`)
    process.exit(1)
  }
  const out = resolve(arg('--out') ?? `eval/traces/${runId}.draft.json`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(draft, null, 2), 'utf-8')
  console.log(`草稿已写入 ${out}`)
  console.log(`待核对 ${draft.meta.needsReview.join(' ')}`)
} finally {
  db.close()
}
