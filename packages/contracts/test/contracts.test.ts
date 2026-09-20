/**
 * 契约自检测试
 *
 * 校验枚举完整性 迁移表覆盖与事件 schema 的合法非法样例
 * 任何契约变更都必须先通过这里的测试
 */

import { describe, expect, it } from 'vitest'
import {
  AgentOutput,
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
  RETURN_STATUSES,
  RETURN_TRANSITIONS,
  RUN_STATUSES,
  RUN_TRANSITIONS,
  REFUND_STATUSES,
  REFUND_TRANSITIONS,
  TOOL_CATALOG,
  ToolErrorShape,
  AGENT_TOOLS,
} from '../src/index.js'

describe('状态迁移表', () => {
  it('每个运行状态都有迁移声明', () => {
    for (const status of RUN_STATUSES) {
      expect(RUN_TRANSITIONS[status]).toBeDefined()
    }
  })

  it('每个售后单状态都有迁移声明', () => {
    for (const status of RETURN_STATUSES) {
      expect(RETURN_TRANSITIONS[status]).toBeDefined()
    }
  })

  it('每个退款状态都有迁移声明', () => {
    for (const status of REFUND_STATUSES) {
      expect(REFUND_TRANSITIONS[status]).toBeDefined()
    }
  })

  it('终态不允许再迁移', () => {
    expect(RUN_TRANSITIONS.completed).toEqual([])
    expect(RETURN_TRANSITIONS.rejected).toEqual([])
    expect(REFUND_TRANSITIONS.succeeded).toEqual([])
  })
})

describe('事件协议', () => {
  it('事件类型与 payload schema 一一对应', () => {
    const schemaKeys = Object.keys(EVENT_PAYLOAD_SCHEMAS)
    expect(schemaKeys.sort()).toEqual([...EVENT_TYPES].sort())
  })

  it('run.started payload 合法样例通过校验', () => {
    const parsed = EVENT_PAYLOAD_SCHEMAS['run.started'].safeParse({
      customerId: 'C1001',
      promptVersion: 'v1',
      model: 'scripted',
    })
    expect(parsed.success).toBe(true)
  })

  it('tool.completed 缺少 latencyMs 被拒绝', () => {
    const parsed = EVENT_PAYLOAD_SCHEMAS['tool.completed'].safeParse({
      executionId: 'tx1',
      toolName: 'get_order',
      status: 'succeeded',
    })
    expect(parsed.success).toBe(false)
  })
})

describe('Agent 输出契约', () => {
  it('tool_call 只允许白名单只读工具', () => {
    const parsed = AgentOutput.safeParse({
      kind: 'tool_call',
      tool: 'execute_refund',
      args: { returnNo: 'RT-2026-0001' },
      reason: '直接退款',
    })
    expect(parsed.success).toBe(false)
  })

  it('action 携带合法意图通过校验', () => {
    const parsed = AgentOutput.safeParse({
      kind: 'action',
      intent: 'submit_refund_only',
      slots: { orderNo: 'SO-2026-0001', reason: 'unshipped_cancel' },
      reason: '订单未发货 用户申请仅退款',
    })
    expect(parsed.success).toBe(true)
  })

  it('clarify 缺少 question 被拒绝', () => {
    const parsed = AgentOutput.safeParse({ kind: 'clarify', missingSlots: ['orderNo'] })
    expect(parsed.success).toBe(false)
  })

  it('Agent 工具白名单不含副作用工具', () => {
    const sideEffectTools = TOOL_CATALOG.filter((t) => t.exposedTo !== 'agent').map((t) => t.name)
    for (const tool of sideEffectTools) {
      expect(AGENT_TOOLS).not.toContain(tool)
    }
  })
})

describe('错误契约', () => {
  it('携带合法错误码的形状通过校验', () => {
    const parsed = ToolErrorShape.safeParse({
      code: 'RATE_LIMITED',
      message: '触发限流',
      retryable: true,
    })
    expect(parsed.success).toBe(true)
  })

  it('未知错误码被拒绝', () => {
    const parsed = ToolErrorShape.safeParse({
      code: 'SOMETHING_ELSE',
      message: 'x',
      retryable: false,
    })
    expect(parsed.success).toBe(false)
  })
})

describe('工具目录治理', () => {
  it('高风险工具全部幂等', () => {
    for (const tool of TOOL_CATALOG.filter((t) => t.risk === 'high')) {
      expect(tool.idempotent).toBe(true)
    }
  })

  it('高风险工具不暴露给模型', () => {
    for (const tool of TOOL_CATALOG.filter((t) => t.risk === 'high')) {
      expect(tool.exposedTo).not.toBe('agent')
    }
  })
})
