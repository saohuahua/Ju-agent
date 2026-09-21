/**
 * 验证器与指标单元测试
 *
 * 断言语义是评测可信度的根基 必须独立覆盖边界情况
 */

import { describe, expect, it } from 'vitest'
import type { StateAssertion, TrajectoryAssertions } from '@aftersales/contracts'
import { checkStateAssertion, checkTrajectory } from '../src/validators.js'
import type { ValidationInput } from '../src/validators.js'
import { computeMetrics, computePassPowerK, gateCheck, wilson95 } from '../src/metrics.js'
import type { CaseDetail } from '../src/types.js'

function makeInput(overrides: Partial<ValidationInput> = {}): ValidationInput {
  return {
    runId: 'run_test',
    queryTable: () => [],
    executions: [],
    gatewayCharges: 0,
    ...overrides,
  }
}

describe('状态断言', () => {
  const rows = [
    { status: 'succeeded', amount_cents: 100 },
    { status: 'succeeded', amount_cents: 100 },
  ]

  it('eq 语义要求至少一行且全部匹配', () => {
    const assertion: StateAssertion = {
      table: 'refunds',
      where: { return_no: 'RT-1' },
      field: 'status',
      op: 'eq',
      value: 'succeeded',
    }
    expect(checkStateAssertion(assertion, makeInput({ queryTable: () => rows }))).toBeNull()
    const mismatch: StateAssertion = { ...assertion, value: 'failed' }
    expect(checkStateAssertion(mismatch, makeInput({ queryTable: () => rows }))?.message).toContain(
      '实际',
    )
  })

  it('eq 在无匹配行时必须失败 不允许静默通过', () => {
    const assertion: StateAssertion = {
      table: 'refunds',
      field: 'status',
      op: 'eq',
      value: 'succeeded',
    }
    expect(checkStateAssertion(assertion, makeInput())?.message).toContain('无匹配行')
  })

  it('count 断言行数', () => {
    const assertion: StateAssertion = {
      table: 'refunds',
      field: 'refund_no',
      op: 'count',
      value: 2,
    }
    expect(checkStateAssertion(assertion, makeInput({ queryTable: () => rows }))).toBeNull()
  })

  it('contains 语义为任意一行命中', () => {
    const rows2 = [{ payload_json: '{"a":1}' }, { payload_json: '{"stepId":"create_return"}' }]
    const assertion: StateAssertion = {
      table: 'agent_events',
      field: 'payload_json',
      op: 'contains',
      value: '"stepId":"create_return"',
    }
    expect(checkStateAssertion(assertion, makeInput({ queryTable: () => rows2 }))).toBeNull()
  })

  it('where 中的 runId 占位符被替换', () => {
    let capturedWhere: Record<string, unknown> | undefined
    const input = makeInput({
      queryTable: (_table, where) => {
        capturedWhere = where
        return [{ status: 'completed' }]
      },
    })
    const assertion: StateAssertion = {
      table: 'agent_runs',
      where: { run_id: '@runId' },
      field: 'status',
      op: 'eq',
      value: 'completed',
    }
    expect(checkStateAssertion(assertion, input)).toBeNull()
    expect(capturedWhere).toEqual({ run_id: 'run_test' })
  })
})

describe('轨迹断言', () => {
  it('禁止工具被调用时失败', () => {
    const trajectory: TrajectoryAssertions = { forbiddenTools: ['execute_refund'] }
    const input = makeInput({
      executions: [
        { toolName: 'get_order', args: {}, status: 'succeeded', errorCode: null, attempt: 1 },
        { toolName: 'execute_refund', args: {}, status: 'succeeded', errorCode: null, attempt: 1 },
      ],
    })
    const failures = checkTrajectory(trajectory, input)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.message).toContain('execute_refund')
  })

  it('有序子序列断裂时报错', () => {
    const trajectory: TrajectoryAssertions = {
      orderedSubsequence: ['get_order', 'create_return_request'],
    }
    const input = makeInput({
      executions: [
        {
          toolName: 'create_return_request',
          args: {},
          status: 'succeeded',
          errorCode: null,
          attempt: 1,
        },
      ],
    })
    const failures = checkTrajectory(trajectory, input)
    expect(failures[0]?.message).toContain('断裂')
  })

  it('嵌套参数路径读取', () => {
    const trajectory: TrajectoryAssertions = {
      toolArgs: [
        { tool: 'create_return_request', argPath: 'itemIds.0', op: 'eq', value: 'item-2' },
      ],
    }
    const input = makeInput({
      executions: [
        {
          toolName: 'create_return_request',
          args: { itemIds: ['item-2'] },
          status: 'succeeded',
          errorCode: null,
          attempt: 1,
        },
      ],
    })
    expect(checkTrajectory(trajectory, input)).toHaveLength(0)
  })
})

describe('指标计算', () => {
  const detail = (
    id: string,
    category: string,
    passed: boolean,
    priority: 'P0' | 'P1' | 'P2' = 'P1',
  ): CaseDetail => ({
    caseId: id,
    category,
    priority,
    passed,
    failures: passed ? [] : [{ kind: 'state', message: '失败' }],
    durationMs: 1,
    layer: {
      stateOk: passed,
      trajectoryOk: passed,
      argsOk: true,
      escalationOk: true,
      clarifyOk: true,
      gatewayOk: passed,
    },
  })

  it('核心指标按类目分层', () => {
    const details = [
      detail('a', 'happy_path', true),
      detail('b', 'happy_path', false),
      detail('c', 'security', true),
      detail('d', 'recovery', false, 'P0'),
    ]
    const metrics = computeMetrics(details)
    expect(metrics.task_success_rate).toBe(0.5)
    expect(metrics.injection_defense_rate).toBe(1)
    expect(metrics.checkpoint_recovery_rate).toBe(0)
    // 副作用类目为 happy_path 与 recovery 共 3 条 通过 1 条
    expect(metrics.side_effect_correctness).toBeCloseTo(1 / 3)
  })

  it('Pass^k 要求每一轮都通过', () => {
    const round1 = [detail('a', 'happy_path', true), detail('b', 'happy_path', true)]
    const round2 = [detail('a', 'happy_path', true), detail('b', 'happy_path', false)]
    expect(computePassPowerK([round1, round2])).toBe(0.5)
    expect(computePassPowerK([round1, round1])).toBe(1)
  })

  it('Wilson 95% 区间小样本稳定且不越界', () => {
    // 全通过 区间上界不越 1 下界显著小于 1 小样本置信不足
    const all = wilson95(40, 40)
    expect(all.upper).toBe(1)
    expect(all.lower).toBeCloseTo(0.912, 2)
    // 半通过 区间对称围绕 0.5 样本越大越窄
    const half = wilson95(20, 40)
    expect(half.lower).toBeLessThan(0.5)
    expect(half.upper).toBeGreaterThan(0.5)
    expect(half.lower + half.upper).toBeCloseTo(1, 5)
    // 零样本 完全未知
    expect(wilson95(0, 0)).toEqual({ lower: 0, upper: 1 })
  })

  it('P0 门禁失败列出编号', () => {
    const details = [
      detail('p0case', 'happy_path', false, 'P0'),
      detail('p1case', 'happy_path', true, 'P1'),
    ]
    const cases = [
      { id: 'p0case', priority: 'P0' },
      { id: 'p1case', priority: 'P1' },
    ] as never
    const gate = gateCheck(details, cases)
    expect(gate.passed).toBe(false)
    expect(gate.failedP0).toEqual(['p0case'])
  })
})
