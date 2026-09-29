import { afterEach, describe, expect, it } from 'vitest'
import { ScriptedModel } from '@aftersales/agent'
import { FrozenClock } from '@aftersales/domain'
import { composeSystem, type ComposedSystem } from '@aftersales/runtime'
import { createApp } from '../src/app.js'
import { customerEvent } from '../src/customer-view.js'

const systems: ComposedSystem[] = []
const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

afterEach(() => systems.splice(0).forEach((system) => system.db.close()))

/** 用含内部字段的持久事件验证两个公开通道采用相同白名单 */
async function fixture() {
  const system = composeSystem({
    clock: new FrozenClock('2026-09-20T12:00:00Z'),
    model: new ScriptedModel([]),
  })
  systems.push(system)
  const run = await system.runService.start({
    customerId: 'C1001',
    model: 'private-model',
    promptVersion: 'private-prompt',
    faultPlan: ['private-plan'],
  })
  await system.runService.transition(run.runId, 'running')
  await system.runService.emit(run.runId, 'message.user', {
    text: '请处理订单',
    replyToToolCallId: 'private-call',
    secret: 'private-extra',
  })
  await system.runService.emit(run.runId, 'agent.tool_results', {
    results: [{ content: 'private-tool-result' }],
  })
  await system.runService.emit(run.runId, 'operator.message', {
    text: '正在为您核验',
    sentBy: 'private-staff',
  })
  await system.runService.emit(run.runId, 'run.failed', {
    message: 'private-diagnostic',
    errorCode: 'INTERNAL_ERROR',
  })
  await system.runService.emit(run.runId, 'guard.blocked', { key: 'private-key' })
  await system.runService.transition(run.runId, 'failed', { error: 'private-error' })

  return { app: createApp({ system, modelAvailable: false }), runId: run.runId }
}

describe('客户公开视图', () => {
  it('动作投影严格白名单 不能通过标识状态旁路泄漏参数和结果', () => {
    for (const type of ['tool.requested', 'tool.completed'] as const) {
      const projected = customerEvent({
        runId: 'r',
        sequence: 2,
        type,
        createdAt: '',
        payload: {
          executionId: 'action-a',
          toolName: 'search_policy',
          status: 'succeeded',
          args: { key: 'private-key' },
          result: { secret: 'private-result' },
          errorCode: 'private-error',
          attempt: 3,
        },
      })
      expect(projected?.payload).toEqual({
        executionId: 'action-a',
        toolName: 'search_policy',
        ...(type === 'tool.completed' ? { status: 'succeeded' } : {}),
      })
      expect(JSON.stringify(projected)).not.toContain('private-')
    }
    expect(
      customerEvent({
        runId: 'r',
        sequence: 2,
        type: 'tool.completed',
        createdAt: '',
        payload: { toolName: 'private-tool' },
      }),
    ).toBeNull()
  })
  it('JSON 和 SSE 去除工具与内部字段 保留消息并推进隐藏尾部的游标', async () => {
    const { app, runId } = await fixture()
    const headers = auth('cust-token-1001')
    const response = await app.request(`/api/runs/${runId}/events/json`, { headers })
    const json = (await response.json()) as {
      events: Array<{ sequence: number; payload: unknown }>
    }
    expect(json.events.map((event) => event.sequence)).toEqual([1, 3, 4])
    expect(json.events[0]?.payload).toEqual({ text: '请处理订单' })
    expect(JSON.stringify(json)).not.toContain('private-')

    const stream = await app.request(`/api/runs/${runId}/events`, {
      headers: { ...headers, 'Last-Event-ID': '1' },
    })
    expect(stream.headers.get('cache-control')).toContain('no-transform')
    const body = await stream.text()
    expect(body).not.toContain('private-')
    expect(body).not.toContain('id: 1\n')
    expect(body).toContain('id: 3\nevent: operator.message')
    expect(body).toContain('id: 5\nevent: stream.cursor')
    expect(body).toContain('event: stream.complete')

    const resumed = await app.request(`/api/runs/${runId}/events`, {
      headers: { ...headers, 'Last-Event-ID': '5' },
    })
    const tail = await resumed.text()
    expect(tail).not.toContain('operator.message')
    expect(tail).toContain('stream.complete')
  })

  it('员工仍可取诊断 客户无法从运行列表与详情绕过事件白名单', async () => {
    const { app, runId } = await fixture()
    const staff = await app.request(`/api/runs/${runId}/events/json`, {
      headers: auth('operator-token'),
    })
    expect(await staff.text()).toContain('private-tool-result')

    for (const path of ['/api/runs', `/api/runs/${runId}`]) {
      const response = await app.request(path, { headers: auth('cust-token-1001') })
      expect(response.status).toBe(200)
      expect(await response.text()).not.toContain('private-')
    }
  })

  it('他人身份不能读取公开消息或原始事件', async () => {
    const { app, runId } = await fixture()
    for (const suffix of ['events', 'events/json']) {
      expect(
        (await app.request(`/api/runs/${runId}/${suffix}`, { headers: auth('cust-token-1002') }))
          .status,
      ).toBe(403)
    }
  })
})
