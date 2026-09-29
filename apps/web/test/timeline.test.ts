/**
 * 决策轨迹时间轴投影测试
 *
 * 投影是纯函数 覆盖泳道归属 流式折叠 工具配对与横向定位
 * 时间旅行回放（功能 29）将复用同一条路径 这里锁死其语义
 */

import { describe, expect, it } from 'vitest'
import { projectTimeline, timelineHint } from '../src/lib/timeline'
import type { AgentEvent } from '../src/lib/types'

function event(sequence: number, type: string, payload: Record<string, unknown>): AgentEvent {
  return { runId: 'run_t', sequence, type, payload, createdAt: '2026-09-20T12:00:00.000Z' }
}

describe('泳道归属', () => {
  it('悬浮说明按事件事实概括 不把待执行工具说成已完成', () => {
    const pending = projectTimeline([
      event(1, 'tool.requested', { executionId: 'e1', toolName: 'get_order' }),
    ])[0]!
    expect(timelineHint(pending)).toContain('正在核对订单')
    const completed = projectTimeline([
      event(1, 'tool.requested', { executionId: 'e1', toolName: 'get_order' }),
      event(2, 'tool.completed', { executionId: 'e1', toolName: 'get_order', status: 'succeeded' }),
    ])[0]!
    expect(timelineHint(completed)).toBe('核对订单和商品完成')
    const failed = projectTimeline([
      event(1, 'tool.completed', {
        executionId: 'e2',
        toolName: 'search_policy',
        status: 'failed',
      }),
    ])[0]!
    expect(timelineHint(failed)).toBe('检索售后政策失败')
    const user = projectTimeline([event(1, 'message.user', { text: '包裹一直没有物流更新' })])[0]!
    expect(timelineHint(user)).toBe('客户说 包裹一直没有物流更新')
  })
  it('五类事件各归其道 未识别类型不产生节点', () => {
    const nodes = projectTimeline([
      event(1, 'run.started', { customerId: 'C1001' }),
      event(2, 'message.user', { text: '查单' }),
      event(3, 'agent.turn', { blocks: [], stopReason: 'tool_use' }),
      event(4, 'tool.completed', {
        executionId: 'e1',
        toolName: 'get_order',
        status: 'succeeded',
        latencyMs: 12,
      }),
      event(5, 'approval.required', { approvalId: 'a1' }),
      event(6, 'operator.message', { text: '您好', sentBy: 'op' }),
      event(7, 'agent.output', { output: {} }),
    ])
    const lanes = nodes.map((node) => node.lane)
    expect(lanes).toContain('system')
    expect(lanes).toContain('user')
    expect(lanes).toContain('model')
    expect(lanes).toContain('tool')
    expect(lanes).toContain('human')
    // agent.output 未映射泳道 不产生节点
    expect(nodes).toHaveLength(6)
  })
})

describe('流式折叠与工具配对', () => {
  it('message.delta 折叠进模型文本节点 不产生独立节点', () => {
    const nodes = projectTimeline([
      event(1, 'run.started', {}),
      event(2, 'message.delta', { textDelta: '订单' }),
      event(3, 'message.delta', { textDelta: '已签收' }),
      event(4, 'message.completed', { role: 'assistant', text: '订单已签收' }),
    ])
    expect(nodes.filter((node) => node.kind === 'model-text')).toHaveLength(1)
  })

  it('工具 requested 与 completed 按 executionId 配对 标注耗时与状态', () => {
    const nodes = projectTimeline([
      event(1, 'tool.requested', {
        executionId: 'e1',
        toolName: 'get_order',
        attempt: 1,
        args: {},
      }),
      event(2, 'tool.completed', {
        executionId: 'e1',
        toolName: 'get_order',
        status: 'succeeded',
        latencyMs: 142,
      }),
    ])
    const tool = nodes.find((node) => node.kind === 'tool-call')
    expect(tool).toBeDefined()
    expect(tool!.latencyMs).toBe(142)
    expect(tool!.status).toBe('succeeded')
    // 配对后只有一个工具节点
    expect(nodes).toHaveLength(1)
  })

  it('tool.input.delta 逐帧留存在节点上 拼接可见完整入参', () => {
    const nodes = projectTimeline([
      event(1, 'tool.input.delta', {
        toolCallId: 't1',
        toolName: 'get_order',
        partialJson: '{"order',
      }),
      event(2, 'tool.input.delta', {
        toolCallId: 't1',
        toolName: 'get_order',
        partialJson: 'No":"SO-1"}',
      }),
    ])
    const tool = nodes[0]!
    expect(tool.inputFrames).toEqual(['{"order', 'No":"SO-1"}'])
  })
})

describe('横向定位', () => {
  it('节点均匀分布在 0 到 1 首尾留边', () => {
    const nodes = projectTimeline([
      event(1, 'run.started', {}),
      event(2, 'message.user', { text: 'a' }),
      event(3, 'message.completed', { role: 'assistant', text: 'b' }),
      event(4, 'run.completed', { summary: '', escalated: false }),
    ])
    expect(nodes[0]!.x).toBe(0)
    expect(nodes[nodes.length - 1]!.x).toBe(1)
    const xs = nodes.map((node) => node.x)
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
  })

  it('单节点居中', () => {
    const nodes = projectTimeline([event(1, 'run.started', {})])
    expect(nodes[0]!.x).toBe(0.5)
  })
})
