/**
 * 确定性验证器
 *
 * 评测的核心原则 最终状态由数据库断言 轨迹由工具执行记录断言
 * 不存在任何主观打分 LLM Judge 只用于回复质量且不决定任务成功
 */

import type { StateAssertion, ToolArgAssertion, TrajectoryAssertions } from '@aftersales/contracts'
import type { ToolExecution } from './types.js'

/** 评测器内部使用的行类型 来自持久层原始查询 */
export type QueryRow = Record<string, unknown>

export interface ValidationInput {
  runId: string
  /** 断言用行查询函数 由运行器注入 */
  queryTable: (table: string, where?: Record<string, unknown>) => QueryRow[]
  /** 全部工具执行记录 */
  executions: ToolExecution[]
  /** 网关成功扣款次数 */
  gatewayCharges: number
}

export interface AssertionFailure {
  kind: 'state' | 'trajectory' | 'escalation' | 'clarify' | 'gateway'
  message: string
}

/** where 条件中的 @runId 占位符替换为实际运行标识 */
function resolveWhere(
  where: Record<string, unknown> | undefined,
  runId: string,
): Record<string, unknown> | undefined {
  if (!where) return undefined
  const resolved: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(where)) {
    resolved[key] = value === '@runId' ? runId : value
  }
  return resolved
}

/** 单条状态断言 按声明语义严格执行 eq 语义要求至少一行且全部匹配 */
export function checkStateAssertion(
  assertion: StateAssertion,
  input: ValidationInput,
): AssertionFailure | null {
  const rows = input.queryTable(assertion.table, resolveWhere(assertion.where, input.runId))
  const label = `${assertion.table}${assertion.where ? ` ${JSON.stringify(assertion.where)}` : ''}.${assertion.field} ${assertion.op} ${JSON.stringify(assertion.value ?? null)}`
  const note = assertion.note ? ` ${assertion.note}` : ''

  switch (assertion.op) {
    case 'exists': {
      if (rows.length === 0) {
        return { kind: 'state', message: `断言失败 ${label} 期望至少一行 实际 0 行${note}` }
      }
      return null
    }
    case 'missing': {
      if (rows.length > 0) {
        return {
          kind: 'state',
          message: `断言失败 ${label} 期望 0 行 实际 ${rows.length} 行${note}`,
        }
      }
      return null
    }
    case 'count': {
      if (rows.length !== assertion.value) {
        return { kind: 'state', message: `断言失败 ${label} 实际 ${rows.length} 行${note}` }
      }
      return null
    }
    case 'eq':
    case 'ne': {
      if (rows.length === 0) {
        return { kind: 'state', message: `断言失败 ${label} 无匹配行${note}` }
      }
      const mismatched = rows.filter((row) => row[assertion.field] !== assertion.value)
      const allEqual = mismatched.length === 0
      if (assertion.op === 'eq' && !allEqual) {
        const first = rows[0]![assertion.field]
        return { kind: 'state', message: `断言失败 ${label} 实际 ${JSON.stringify(first)}${note}` }
      }
      if (assertion.op === 'ne' && allEqual) {
        return {
          kind: 'state',
          message: `断言失败 ${label} 全部等于 ${JSON.stringify(assertion.value)}${note}`,
        }
      }
      return null
    }
    case 'contains':
    case 'not_contains': {
      if (rows.length === 0) {
        return { kind: 'state', message: `断言失败 ${label} 无匹配行${note}` }
      }
      // 语义为存在性检查 任意一行命中即算包含
      const has = rows.some((row) =>
        String(row[assertion.field] ?? '').includes(String(assertion.value)),
      )
      if (assertion.op === 'contains' && !has) {
        return {
          kind: 'state',
          message: `断言失败 ${label} 所有行均未包含 ${JSON.stringify(assertion.value)}${note}`,
        }
      }
      if (assertion.op === 'not_contains' && has) {
        return {
          kind: 'state',
          message: `断言失败 ${label} 存在包含 ${JSON.stringify(assertion.value)} 的行${note}`,
        }
      }
      return null
    }
    default:
      return { kind: 'state', message: `未知断言操作 ${assertion.op}` }
  }
}

/** 按点路径读取嵌套值 支持 0 起始数字下标 */
function readPath(source: unknown, path: string): unknown {
  let current: unknown = source
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(segment)
      current = Number.isNaN(index) ? undefined : current[index]
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment]
    } else {
      return undefined
    }
  }
  return current
}

/** 轨迹断言 必选工具 禁止工具 有序子序列 参数匹配 步数上限 */
export function checkTrajectory(
  trajectory: TrajectoryAssertions,
  input: ValidationInput,
): AssertionFailure[] {
  const failures: AssertionFailure[] = []
  const tools = input.executions.map((execution) => execution.toolName)

  for (const required of trajectory.requiredTools ?? []) {
    if (!tools.includes(required)) {
      failures.push({ kind: 'trajectory', message: `断言失败 必须调用的工具 ${required} 未被调用` })
    }
  }
  for (const forbidden of trajectory.forbiddenTools ?? []) {
    if (tools.includes(forbidden)) {
      failures.push({
        kind: 'trajectory',
        message: `断言失败 禁止调用的工具 ${forbidden} 被调用了 ${tools.filter((t) => t === forbidden).length} 次`,
      })
    }
  }

  if (trajectory.orderedSubsequence) {
    let cursor = 0
    for (const expected of trajectory.orderedSubsequence) {
      const foundAt = tools.indexOf(expected, cursor)
      if (foundAt === -1) {
        failures.push({
          kind: 'trajectory',
          message: `断言失败 有序轨迹 ${trajectory.orderedSubsequence.join(' -> ')} 在 ${expected} 处断裂`,
        })
        break
      }
      cursor = foundAt + 1
    }
  }

  for (const argAssertion of trajectory.toolArgs ?? []) {
    const target = input.executions.find((execution) => execution.toolName === argAssertion.tool)
    if (!target) {
      failures.push({
        kind: 'trajectory',
        message: `断言失败 工具 ${argAssertion.tool} 未执行 无法校验参数`,
      })
      continue
    }
    const actual = readPath(target.args, argAssertion.argPath)
    const matches =
      argAssertion.op === 'eq' ? actual === argAssertion.value : actual !== argAssertion.value
    if (!matches) {
      failures.push({
        kind: 'trajectory',
        message: `断言失败 ${argAssertion.tool} 参数 ${argAssertion.argPath} 期望 ${argAssertion.op} ${JSON.stringify(argAssertion.value)} 实际 ${JSON.stringify(actual)}`,
      })
    }
  }

  if (trajectory.maxToolCalls && input.executions.length > trajectory.maxToolCalls) {
    failures.push({
      kind: 'trajectory',
      message: `断言失败 工具调用 ${input.executions.length} 次超过上限 ${trajectory.maxToolCalls}`,
    })
  }

  return failures
}

/** 工具参数断言单独成组 供 tool_argument_accuracy 指标统计 */
export function checkToolArgs(
  assertions: ToolArgAssertion[],
  input: ValidationInput,
): AssertionFailure[] {
  const failures: AssertionFailure[] = []
  for (const assertion of assertions) {
    const target = input.executions.find((execution) => execution.toolName === assertion.tool)
    if (!target) {
      failures.push({ kind: 'trajectory', message: `断言失败 工具 ${assertion.tool} 未执行` })
      continue
    }
    const actual = readPath(target.args, assertion.argPath)
    if (assertion.op === 'eq' && actual !== assertion.value) {
      failures.push({
        kind: 'trajectory',
        message: `断言失败 ${assertion.tool} 参数 ${assertion.argPath} 期望 ${JSON.stringify(assertion.value)} 实际 ${JSON.stringify(actual)}`,
      })
    }
    if (assertion.op === 'ne' && actual === assertion.value) {
      failures.push({
        kind: 'trajectory',
        message: `断言失败 ${assertion.tool} 参数 ${assertion.argPath} 不应等于 ${JSON.stringify(assertion.value)}`,
      })
    }
  }
  return failures
}
