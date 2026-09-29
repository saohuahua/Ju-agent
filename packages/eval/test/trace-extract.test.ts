/**
 * 会话转用例草稿
 */

import { describe, expect, it } from 'vitest'
import { EvalCase } from '@aftersales/contracts'
import { extractCaseDraft } from '../src/trace-extract.js'
import { runCase } from '../src/runner.js'

const run = {
  runId: 'run_trace1',
  customerId: 'C1001',
  status: 'completed',
  promptVersion: 'v2.5',
  model: 'scripted-v1',
  source: 'customer',
  createdAt: '2026-09-20T12:00:00.000Z',
}

describe('extractCaseDraft', () => {
  it('映射查单轨迹并生成可通过契约的草稿', () => {
    const draft = extractCaseDraft(run, [
      {
        sequence: 1,
        type: 'message.user',
        payload: { text: '我的订单 SO-2026-0002 到哪了' },
      },
      {
        sequence: 2,
        type: 'agent.turn',
        payload: {
          stopReason: 'tool_use',
          blocks: [
            {
              type: 'tool_use',
              toolCallId: 'c1',
              toolName: 'get_order',
              input: { orderNo: 'SO-2026-0002' },
            },
          ],
        },
      },
      {
        sequence: 3,
        type: 'agent.turn',
        payload: {
          stopReason: 'tool_use',
          blocks: [
            { type: 'text', text: '您的订单已发货 正在运输途中' },
            {
              type: 'tool_use',
              toolCallId: 'c2',
              toolName: 'conclude',
              input: { summary: '查单完成' },
            },
          ],
        },
      },
      {
        sequence: 4,
        type: 'message.completed',
        payload: { role: 'assistant', text: '您的订单已发货 正在运输途中' },
      },
      {
        sequence: 5,
        type: 'run.completed',
        payload: { summary: '查单完成', escalated: false },
      },
    ])
    expect(draft.case.turns[0]?.userMessage).toContain('SO-2026-0002')
    expect(draft.case.modelScript[0]).toMatchObject({ kind: 'tool_call', tool: 'get_order' })
    expect(draft.case.modelScript[1]).toMatchObject({ kind: 'final', summary: '查单完成' })
    expect(EvalCase.safeParse(draft.case).success).toBe(true)
  })

  it('映射澄清 动作与升级', () => {
    const draft = extractCaseDraft(run, [
      { sequence: 1, type: 'message.user', payload: { text: '我要退货' } },
      {
        sequence: 2,
        type: 'agent.turn',
        payload: {
          blocks: [
            {
              type: 'tool_use',
              toolName: 'ask_user',
              input: { question: '请提供订单号', missingSlot: 'orderNo' },
            },
          ],
        },
      },
      { sequence: 3, type: 'message.user', payload: { text: 'SO-2026-0002 质量问题' } },
      {
        sequence: 4,
        type: 'agent.turn',
        payload: {
          blocks: [
            {
              type: 'tool_use',
              toolName: 'submit_return',
              input: {
                orderNo: 'SO-2026-0002',
                reason: 'quality',
                itemIds: ['item-0002-1'],
                explanation: '质量问题退货',
              },
            },
          ],
        },
      },
      {
        sequence: 5,
        type: 'agent.turn',
        payload: {
          blocks: [
            {
              type: 'tool_use',
              toolName: 'escalate',
              input: { reason: '客户要求人工', kind: 'customer_request' },
            },
          ],
        },
      },
    ])
    expect(draft.case.modelScript.map((step) => step.kind)).toEqual([
      'clarify',
      'action',
      'escalate',
    ])
    expect(draft.case.turns).toHaveLength(2)
  })

  it('生成的查单草稿可被 L1 重放', async () => {
    const draft = extractCaseDraft(run, [
      { sequence: 1, type: 'message.user', payload: { text: '我的订单 SO-2026-0002 到哪了' } },
      {
        sequence: 2,
        type: 'agent.turn',
        payload: {
          blocks: [
            {
              type: 'tool_use',
              toolName: 'get_order',
              input: { orderNo: 'SO-2026-0002' },
            },
          ],
        },
      },
      {
        sequence: 3,
        type: 'agent.turn',
        payload: {
          blocks: [
            { type: 'text', text: '您的订单已发货 正在运输途中' },
            { type: 'tool_use', toolName: 'conclude', input: { summary: '查单完成' } },
          ],
        },
      },
    ])
    const parsed = EvalCase.parse({ ...draft.case, id: 'reg_query_order_from_trace' })
    const result = await runCase(parsed)
    expect(result.passed).toBe(true)
  })
})
