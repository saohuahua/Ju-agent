/**
 * 将会话导出为 OTLP JSON
 *
 * 用法 pnpm trace:export -- --run <runId> [--db path] [--out file]
 * 缺省读取本地离线业务库 导出后立即校验 失败非零退出
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mapRunToOtlp, validateTrace, type TraceModelCall } from '@aftersales/telemetry'
import {
  openDatabase,
  P7Ledger,
  SqliteAgentRunRepository,
  SqliteEventRepository,
  SqliteToolExecutionRepository,
} from '@aftersales/persistence'
import { businessPath } from './local-offline-paths.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`参数 ${name} 缺少值`)
  return value
}

function parseUsage(raw: string | null): TraceModelCall['usage'] {
  if (!raw) return null
  const parsed = JSON.parse(raw) as { inputTokens?: unknown; outputTokens?: unknown }
  if (typeof parsed.inputTokens !== 'number' || typeof parsed.outputTokens !== 'number') return null
  return { inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens }
}

const runId = arg('--run')
if (!runId) {
  console.error('用法 pnpm trace:export -- --run <runId> [--db path] [--out file]')
  process.exit(1)
}

const dbPath = resolve(arg('--db') ?? businessPath)
const db = openDatabase(dbPath)
try {
  const run = await new SqliteAgentRunRepository(db).findById(runId)
  if (!run) {
    console.error(`运行不存在 ${runId}`)
    process.exit(1)
  }
  const events = await new SqliteEventRepository(db).listByRun(runId)
  const tools = await new SqliteToolExecutionRepository(db).listByRunId(runId)
  const calls = new P7Ledger(db).listByRun(runId)
  const source = {
    run: {
      runId: run.runId,
      customerId: run.customerId,
      status: run.status,
      promptVersion: run.promptVersion,
      model: run.model,
      source: run.source,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
    events: events.map((event) => ({
      sequence: event.sequence,
      type: event.type,
      payload: event.payload,
      createdAt: event.createdAt,
    })),
    tools: tools.map((tool) => ({
      id: tool.id ?? 0,
      toolName: tool.toolName,
      status: tool.status,
      errorCode: tool.errorCode,
      attempt: tool.attempt,
      latencyMs: tool.latencyMs,
      createdAt: tool.createdAt,
    })),
    calls: calls.map((call) => ({
      callId: call.call_id,
      purpose: call.purpose,
      attempt: call.attempt,
      status: call.status,
      outcome: call.outcome,
      usage: parseUsage(call.usage_json),
      createdAt: call.created_at,
      settledAt: call.settled_at,
    })),
  }
  const trace = mapRunToOtlp(source)
  const errors = validateTrace(source, trace)
  if (errors.length > 0) {
    console.error(`校验失败\n${errors.join('\n')}`)
    process.exit(1)
  }
  const json = JSON.stringify(trace, null, 2)
  const out = arg('--out')
  if (out) {
    writeFileSync(resolve(out), json, 'utf-8')
    console.log(
      `已导出 ${resolve(out)} span ${trace.resourceSpans[0]?.scopeSpans[0]?.spans.length}`,
    )
  } else {
    process.stdout.write(`${json}\n`)
  }
} finally {
  db.close()
}
