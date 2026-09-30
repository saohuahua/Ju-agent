import type { EvalCase } from '@aftersales/contracts'
import type { ComposedSystem } from '@aftersales/runtime'

const privateKey = /(?:authorization|cookie|credential|secret|password|api.?key|token$)/i

// 先收集敏感值再过滤嵌套文本及序列化对象
export function redactEvidence<T>(input: T): T {
  const secrets = new Set<string>()
  const parse = (value: string): unknown => {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return value
    }
  }
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      const parsed = parse(value)
      if (parsed !== value) scan(parsed)
    } else if (Array.isArray(value)) value.forEach(scan)
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (privateKey.test(key) && typeof child === 'string' && child) secrets.add(child)
        scan(child)
      }
    }
  }
  scan(input)
  const clean = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const parsed = parse(value)
      if (parsed !== value) return JSON.stringify(clean(parsed))
      let text = value.replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]')
      text = text.replace(
        /((?:api[_-]?key|(?:send|approval|one_time|access)[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi,
        '$1[REDACTED]',
      )
      for (const secret of secrets) text = text.split(secret).join('[REDACTED]')
      return text
    }
    if (Array.isArray(value)) return value.map(clean)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          privateKey.test(key) ? '[REDACTED]' : clean(child),
        ]),
      )
    return value
  }
  return clean(input) as T
}

// 在独立业务库关闭前保存断言实际查询与关联事件
export function captureBusinessEvidence(
  system: ComposedSystem,
  testCase: EvalCase,
  runId: string,
  level: 'L1' | 'L2',
) {
  return redactEvidence({
    path: 'legacy-eval',
    runId: runId || null,
    commandId: null,
    taskId: null,
    absenceReason: '现有 L1 L2 使用 legacy 组合根 未创建持久命令和任务 不补造标识',
    assertions: testCase.assertions.expectedState
      .filter((item) => !item.level || item.level === level)
      .map((assertion) => ({
        assertion,
        rows: system.queryTable(
          assertion.table,
          assertion.where &&
            Object.fromEntries(
              Object.entries(assertion.where).map(([key, value]) => [
                key,
                value === '@runId' ? runId : value,
              ]),
            ),
        ),
      })),
    runs: runId ? system.queryTable('agent_runs', { run_id: runId }) : [],
    events: runId ? system.queryTable('agent_events', { run_id: runId }) : [],
    executions: system.queryTable('tool_executions'),
    gatewayCharges: system.gateway.totalSuccessfulCharges(),
  })
}

export type BusinessEvidence = ReturnType<typeof captureBusinessEvidence>
