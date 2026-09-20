/**
 * HTTP 应用工厂
 *
 * 路由只做三件事 解析身份 组装调用 返回契约化响应
 * 业务不变量全部在领域层 HTTP 不绕过任何校验
 * 测试通过注入组合系统驱动同一套路由
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  ApprovalDecisionRequest,
  ContinueRunRequest,
  CreateRunRequest,
} from '@aftersales/contracts'
import type { EvalReport } from '@aftersales/contracts'
import { DomainError } from '@aftersales/domain'
import type { Actor } from '@aftersales/domain'
import { PROMPT_VERSION } from '@aftersales/agent'
import { runCase } from '@aftersales/eval'
import { EVAL_CASES, buildReport } from '@aftersales/eval'
import { listEvalReports } from '@aftersales/persistence'
import type { ComposedSystem } from '@aftersales/runtime'
import { ToolExecutionError } from '@aftersales/tools'
import { createAuthEnv, requireActor, requireRole, type AuthEnv } from './auth.js'
import { createEventStream } from './sse.js'

export interface AppDependencies {
  system: ComposedSystem
  authEnv?: AuthEnv
  /** 模型不可用时创建运行返回 503 */
  modelAvailable: boolean
}

/** 领域错误码到 HTTP 状态码 字面量联合保证 hono 重载匹配 */
function statusForCode(code: string): 400 | 403 | 404 | 409 | 429 {
  switch (code) {
    case 'NOT_FOUND':
      return 404
    case 'AUTHORIZATION_DENIED':
      return 403
    case 'CONFLICT':
      return 409
    case 'RATE_LIMITED':
      return 429
    default:
      return 400
  }
}

function errorResponse(
  error: unknown,
): { status: 400 | 403 | 404 | 409 | 429; body: Record<string, unknown> } | null {
  if (error instanceof DomainError) {
    return {
      status: statusForCode(error.shape.code),
      body: { error: error.shape.code, message: error.shape.message },
    }
  }
  if (error instanceof ToolExecutionError) {
    return {
      status: statusForCode(error.code),
      body: { error: error.code, message: error.message },
    }
  }
  return null
}

/** 应用级上下文变量 认证中间件写入 路由读取 */
export interface AppEnv {
  Variables: {
    authEnv: AuthEnv
    actor: Actor
  }
}

export function createApp(deps: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const authEnv = deps.authEnv ?? createAuthEnv()
  const { system } = deps

  app.use('*', async (context, next) => {
    context.set('authEnv', authEnv)
    await next()
  })
  app.use('/api/*', cors())
  app.use('/api/*', requireActor)

  app.get('/api/health', (context) => {
    return context.json({
      status: 'ok',
      modelAvailable: deps.modelAvailable,
      promptVersion: PROMPT_VERSION,
    })
  })

  // ---------- 运行管理 ----------

  app.post('/api/runs', async (context) => {
    if (!deps.modelAvailable) {
      return context.json(
        {
          error: 'MODEL_UNAVAILABLE',
          message: '未配置 ANTHROPIC_API_KEY 无法使用对话能力 其余功能不受影响',
        },
        503,
      )
    }
    const actor = context.get('actor') as Actor
    const body = CreateRunRequest.safeParse(await context.req.json())
    if (!body.success) {
      return context.json({ error: 'VALIDATION_ERROR', message: '请求体不合法' }, 400)
    }
    const customerId = actor.role === 'customer' ? actor.customerId : body.data.customerId
    if (!customerId) {
      return context.json(
        { error: 'VALIDATION_ERROR', message: '操作员创建运行必须指定 customerId' },
        400,
      )
    }

    const run = await system.runService.start({
      customerId,
      promptVersion: PROMPT_VERSION,
      model: deps.system.runner ? 'configured' : 'none',
    })
    const outcome = await system.runner.start(run.runId, body.data.message, {
      actor: { role: 'customer', customerId },
      runId: run.runId,
      faults: null,
    })
    return context.json({ runId: run.runId, outcome }, 201)
  })

  app.get('/api/runs', async (context) => {
    const actor = context.get('actor') as Actor
    const status = context.req.query('status')
    const runs = await system.runService.list({
      status,
      customerId: actor.role === 'customer' ? actor.customerId : undefined,
      limit: 50,
    })
    return context.json({ runs })
  })

  app.get('/api/runs/:runId', async (context) => {
    const actor = context.get('actor') as Actor
    const runId = context.req.param('runId')
    const run = await system.runService.get(runId)
    if (actor.role === 'customer' && run.customerId !== actor.customerId) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '无权访问该会话' }, 403)
    }
    return context.json({ run })
  })

  app.post('/api/runs/:runId/messages', async (context) => {
    const actor = context.get('actor') as Actor
    const runId = context.req.param('runId')
    const body = ContinueRunRequest.safeParse(await context.req.json())
    if (!body.success) {
      return context.json({ error: 'VALIDATION_ERROR', message: '请求体不合法' }, 400)
    }
    const run = await system.runService.get(runId)
    if (actor.role === 'customer' && run.customerId !== actor.customerId) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '无权访问该会话' }, 403)
    }
    try {
      const outcome = await system.runner.continueWithMessage(runId, body.data.message, {
        actor: { role: 'customer', customerId: run.customerId },
        runId,
        faults: null,
      })
      return context.json({ runId, outcome })
    } catch (error) {
      const mapped = errorResponse(error)
      if (mapped) return context.json(mapped.body, mapped.status)
      throw error
    }
  })

  app.post('/api/runs/:runId/resume', async (context) => {
    if (!requireRole(context, ['operator', 'supervisor'])) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '仅操作员可执行断点恢复' }, 403)
    }
    const runId = context.req.param('runId')
    const run = await system.runService.get(runId)
    try {
      const outcome = await system.runner.resumeFromCheckpoint(runId, {
        actor: { role: 'customer', customerId: run.customerId },
        runId,
        faults: null,
      })
      return context.json({ runId, outcome })
    } catch (error) {
      const mapped = errorResponse(error)
      if (mapped) return context.json(mapped.body, mapped.status)
      throw error
    }
  })

  // ---------- 事件流 ----------

  app.get('/api/runs/:runId/events', async (context) => {
    const actor = context.get('actor') as Actor
    const runId = context.req.param('runId')
    const run = await system.runService.get(runId)
    if (actor.role === 'customer' && run.customerId !== actor.customerId) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '无权访问该会话' }, 403)
    }

    const lastEventId = Number(context.req.header('Last-Event-ID') ?? 0) || 0
    const stream = createEventStream(
      {
        listEvents: (id, from) => deps.system.eventRepo.listByRun(id, from),
        isRunTerminal: async (id) => {
          const current = await system.runService.get(id)
          return ['completed', 'failed', 'cancelled', 'escalated'].includes(current.status)
        },
      },
      runId,
      lastEventId,
    )
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  })

  // 事件 JSON 查询 非流式客户端与测试使用
  app.get('/api/runs/:runId/events/json', async (context) => {
    const actor = context.get('actor') as Actor
    const runId = context.req.param('runId')
    const run = await system.runService.get(runId)
    if (actor.role === 'customer' && run.customerId !== actor.customerId) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '无权访问该会话' }, 403)
    }
    const from = Number(context.req.query('from') ?? 1) || 1
    const events = await system.eventRepo.listByRun(runId, from)
    return context.json({ events })
  })

  // ---------- 审批 ----------

  app.get('/api/approvals', async (context) => {
    if (!requireRole(context, ['operator', 'supervisor'])) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '仅内部人员可查看审批' }, 403)
    }
    const pending = await system.approvalService.listPending()
    return context.json({ approvals: pending })
  })

  app.post('/api/runs/:runId/approvals/:approvalId/decide', async (context) => {
    if (!requireRole(context, ['supervisor'])) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '审批决定仅限主管' }, 403)
    }
    const runId = context.req.param('runId')
    const approvalId = context.req.param('approvalId')
    const actor = context.get('actor') as Actor
    const body = ApprovalDecisionRequest.safeParse(await context.req.json())
    if (!body.success) {
      return context.json({ error: 'VALIDATION_ERROR', message: '请求体不合法' }, 400)
    }
    const result = await system.approvalService.decide(actor, approvalId, body.data.decision)
    if (result.outcome === 'already_decided') {
      return context.json({ error: 'CONFLICT', message: '该审批已处理过 不能重复决定' }, 409)
    }
    if (result.outcome === 'expired') {
      return context.json({ error: 'APPROVAL_EXPIRED', message: '审批已过期' }, 409)
    }
    const run = await system.runService.get(runId)
    const outcome = await system.runner.resumeAfterApproval(
      runId,
      approvalId,
      body.data.decision,
      actor.customerId ?? actor.role,
      { actor: { role: 'customer', customerId: run.customerId }, runId, faults: null },
    )
    return context.json({ runId, approvalId, decision: body.data.decision, outcome })
  })

  // ---------- 运营操作 ----------

  app.post('/api/operations/receive-goods', async (context) => {
    if (!requireRole(context, ['operator', 'supervisor'])) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '仅操作员可确认收货' }, 403)
    }
    const actor = context.get('actor') as Actor
    const body = await context.req.json()
    const returnNo = String(body?.returnNo ?? '')
    if (!returnNo) {
      return context.json({ error: 'VALIDATION_ERROR', message: 'returnNo 必填' }, 400)
    }
    try {
      const result = await system.executor.execute(
        'receive_return_goods',
        { returnNo },
        { actor, runId: null, faults: null },
      )
      return context.json({ result })
    } catch (error) {
      const mapped = errorResponse(error)
      if (mapped) return context.json(mapped.body, mapped.status)
      throw error
    }
  })

  // ---------- 评测 ----------

  app.get('/api/eval/reports', async (context) => {
    if (!requireRole(context, ['operator', 'supervisor'])) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '仅内部人员可查看评测' }, 403)
    }
    const reports = listEvalReports(system.db, 10)
    return context.json({ reports })
  })

  app.post('/api/eval/run', async (context) => {
    if (!requireRole(context, ['operator', 'supervisor'])) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '仅内部人员可触发评测' }, 403)
    }
    // 开发与演示环境接口 全量跑脚本化套件约两秒
    const details = []
    for (const testCase of EVAL_CASES) {
      details.push(await runCase(testCase))
    }
    const report: EvalReport = buildReport({
      model: 'scripted-v1',
      promptVersion: PROMPT_VERSION,
      rounds: [details],
      repeat: 1,
      roundDurationsMs: [0],
      cases: EVAL_CASES,
    })
    return context.json({
      reportId: report.reportId,
      total: report.total,
      passed: report.passed,
      gatePassed: report.gatePassed,
    })
  })

  // 统一领域错误出口
  app.onError((error, context) => {
    const mapped = errorResponse(error)
    if (mapped) {
      return context.json(mapped.body, mapped.status)
    }
    console.error('未处理异常', error)
    return context.json({ error: 'INTERNAL_ERROR', message: '服务内部错误' }, 500)
  })

  return app
}
