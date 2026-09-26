import type { P7CallIdentity } from '../../contracts/src/p7-model-gateway.js'
import type { SqliteDatabase } from '../../persistence/src/db.js'
import type { P7LedgerRow } from '../../persistence/src/p7-ledger.js'
import type { P7EvalIdentity, P7EvalRole } from './p7-eval-models.js'

/** 仅投影账本身份和金额 不读取快照正文或价格正文 */
export type P7CostRow = Readonly<
  Pick<P7LedgerRow, 'call_id' | 'reserved' | 'actual' | 'status' | 'outcome'> & {
    operation_id: P7CallIdentity['operationId']
    run_id: P7CallIdentity['runId']
    purpose: string
    attempt: P7CallIdentity['attempt']
    snapshot_version: string
    price_version: string
    currency: 'CNY'
    unit: 'micro_yuan'
  }
>

type Attribution = Readonly<{
  kind: 'eval' | 'unattributed' | 'anomaly'
  reason: 'unrecognized_run' | 'non_eval_purpose' | 'purpose_mismatch' | 'invalid_operation' | null
  identity: Readonly<P7EvalIdentity & { role: P7EvalRole }> | null
  callRound: number | null
}>

function parseTuple(raw: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) && JSON.stringify(value) === raw ? value : null
  } catch {
    return null
  }
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function role(value: unknown): value is P7EvalRole {
  return value === 'main_agent' || value === 'simulator' || value === 'judge'
}

/** 只接受当前工厂的完整规范编码 不使用前缀猜测身份 */
function attribute(row: P7CostRow): Attribution {
  const run = parseTuple(row.run_id)
  if (
    !run ||
    run.length !== 5 ||
    run[0] !== 'p7-eval-v1' ||
    typeof run[1] !== 'string' ||
    !run[1].trim() ||
    typeof run[2] !== 'string' ||
    !run[2].trim() ||
    !positive(run[3]) ||
    !role(run[4])
  )
    return {
      kind: 'unattributed',
      reason: role(row.purpose) ? 'unrecognized_run' : 'non_eval_purpose',
      identity: null,
      callRound: null,
    }
  const identity = { experimentId: run[1], caseId: run[2], repeat: run[3], role: run[4] }
  const operation = parseTuple(row.operation_id)
  const callRound =
    operation?.length === 2 && operation[0] === row.run_id && positive(operation[1])
      ? operation[1]
      : null
  if (row.purpose !== identity.role)
    return { kind: 'anomaly', reason: 'purpose_mismatch', identity, callRound }
  if (callRound === null)
    return { kind: 'anomaly', reason: 'invalid_operation', identity, callRound }
  return { kind: 'eval', reason: null, identity, callRound }
}

function amount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('P7_COST_INVALID_AMOUNT')
  return value
}

function summarize(rows: readonly P7CostRow[]) {
  let settledActual = 0
  let settledCount = 0
  let unknownReserved = 0
  let unknownCount = 0
  let heldReserved = 0
  let heldCount = 0
  let active = 0
  for (const row of rows) {
    amount(row.reserved)
    if (row.currency !== 'CNY' || row.unit !== 'micro_yuan') throw new Error('P7_COST_INVALID_UNIT')
    if (row.status === 'settled') {
      if (row.actual === null) throw new Error('P7_COST_MISSING_ACTUAL')
      settledActual = amount(settledActual + amount(row.actual))
      settledCount++
    } else {
      if (row.actual !== null) throw new Error('P7_COST_INVALID_STATUS')
      if (row.status === 'unknown') {
        unknownReserved = amount(unknownReserved + row.reserved)
        unknownCount++
        if (['TIMEOUT', 'CANCELLED', 'CONNECTION'].includes(row.outcome ?? '')) active++
      } else if (row.status === 'held') {
        heldReserved = amount(heldReserved + row.reserved)
        heldCount++
        active++
      } else throw new Error('P7_COST_INVALID_STATUS')
    }
  }
  return {
    attempts: rows.length,
    logicalCalls: new Set(rows.map((row) => row.operation_id)).size,
    settled: { actual: settledActual, count: settledCount },
    unknown: { reserved: unknownReserved, count: unknownCount },
    held: { reserved: heldReserved, count: heldCount },
    committed: amount(settledActual + unknownReserved + heldReserved),
    hasUncertainCost: unknownCount + heldCount > 0,
    active,
    observation: rows.length === 0 ? ('no_recorded_calls' as const) : ('recorded_calls' as const),
  }
}

type JoinedRow = (P7CostRow | { call_id: null }) & {
  limit_micro: number | null
  blocked: number | null
  concurrency_limit: number | null
}

/** 单条查询提供同一数据库视图 不开启写事务也不初始化数据库 */
export function readP7CostReport(
  db: SqliteDatabase,
  input: Readonly<{ scope: string; experimentId?: string }>,
) {
  if (!input.scope.trim() || (input.experimentId !== undefined && !input.experimentId.trim()))
    throw new Error('P7_COST_INVALID_FILTER')
  const readStartedAt = new Date().toISOString()
  const joined = db
    .prepare(
      `
    SELECT b.limit_micro, b.blocked, b.concurrency_limit,
      c.call_id, c.operation_id, c.run_id, c.purpose, c.attempt,
      c.snapshot_version, c.price_version, c.currency, c.unit,
      c.reserved, c.actual, c.status, c.outcome
    FROM (SELECT ? AS scope) s
    LEFT JOIN p7_budgets b ON b.scope = s.scope
    LEFT JOIN p7_calls c ON c.scope = s.scope
    ORDER BY c.created_at, c.call_id
  `,
    )
    .all(input.scope) as JoinedRow[]
  const readCompletedAt = new Date().toISOString()
  const rows = joined.filter((row): row is JoinedRow & P7CostRow => row.call_id !== null)
  const calls = rows.map((row) => ({
    callId: row.call_id,
    operationId: row.operation_id,
    runId: row.run_id,
    purpose: row.purpose,
    attempt: row.attempt,
    snapshotVersion: row.snapshot_version,
    priceVersion: row.price_version,
    reserved: row.reserved,
    actual: row.actual,
    status: row.status,
    attribution: attribute(row),
  }))
  const totals = summarize(rows)
  const selectedRows = rows.filter(
    (row) =>
      input.experimentId === undefined ||
      attribute(row).identity?.experimentId === input.experimentId,
  )
  const first = joined[0]!
  const budget = {
    scope: input.scope,
    state: first.limit_micro === null ? ('uninitialized' as const) : ('recorded' as const),
    limit: first.limit_micro === null ? null : amount(first.limit_micro),
    blocked: first.blocked === null ? null : first.blocked === 1,
    concurrencyLimit: first.concurrency_limit,
    remaining: first.limit_micro === null ? null : first.limit_micro - totals.committed,
  }
  // 版本二元组独立分组 不根据角色或模型名合并配置
  const configurations = new Map<string, P7CostRow[]>()
  for (const row of rows) {
    const key = JSON.stringify([row.snapshot_version, row.price_version])
    const group = configurations.get(key) ?? []
    group.push(row)
    configurations.set(key, group)
  }
  return {
    schemaVersion: 1 as const,
    scope: input.scope,
    currency: 'CNY' as const,
    unit: 'micro_yuan' as const,
    observation: {
      readStartedAt,
      readCompletedAt,
      consistency: 'single_statement' as const,
      authorization: false as const,
    },
    scopeSummary: totals,
    budget,
    selection: {
      experimentId: input.experimentId ?? null,
      summary: summarize(selectedRows),
      callIds: calls
        .filter(
          (call) =>
            input.experimentId === undefined ||
            call.attribution.identity?.experimentId === input.experimentId,
        )
        .map((call) => call.callId),
    },
    attributionGroups: (['eval', 'unattributed', 'anomaly'] as const).map((kind) => ({
      kind,
      summary: summarize(rows.filter((row) => attribute(row).kind === kind)),
      callIds: calls.filter((call) => call.attribution.kind === kind).map((call) => call.callId),
    })),
    scopeConfigurations: [...configurations.values()].map((group) => ({
      snapshotVersion: group[0]!.snapshot_version,
      priceVersion: group[0]!.price_version,
      summary: summarize(group),
      callIds: group.map((row) => row.call_id),
    })),
    calls,
  }
}

export type P7CostReport = ReturnType<typeof readP7CostReport>
