/**
 * HTTP 应用工厂
 *
 * 路由只做三件事 解析身份 组装调用 返回契约化响应
 * 业务不变量全部在领域层 HTTP 不绕过任何校验
 * 测试通过注入组合系统驱动同一套路由
 */

import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import {
  ApprovalDecisionRequest,
  ContinueRunRequest,
  CreateRunRequest,
  LogisticsEventInjectRequest,
  OperatorMessageRequest,
  RunRatingRequest,
  RunResolveRequest,
  RequestHumanHelp,
} from '@aftersales/contracts'
import { randomUUID } from 'node:crypto'
import { DomainError } from '@aftersales/domain'
import type { Actor } from '@aftersales/domain'
import { PROMPT_VERSION } from '@aftersales/agent'
import {
  EVAL_CASES,
  SourceIdentityError,
  runBudgetedL1,
  offlineEvalRoles,
  saveP7EvalEvidence,
  readP7EvalEvidence,
} from '@aftersales/eval'
import {
  runSimSuite,
  selectCases,
  estimateSuiteTokens,
  type SimSuiteProgress,
} from '@aftersales/eval'
import {
  listEvalReports,
  saveEvalReport,
  SqliteApprovalExecutionRepository,
  SqliteApprovalProgressRepository,
} from '@aftersales/persistence'
import type { ComposedSystem } from '@aftersales/runtime'
import { requestsHuman } from '@aftersales/runtime'
import { ToolExecutionError } from '@aftersales/tools'
import { createAuthEnv, requireActor, requireRole, type AuthEnv } from './auth.js'
import { createEventStream } from './sse.js'
import {
  actorKey,
  ConnectionGate,
  createRateLimitMiddleware,
  type RateLimitOptions,
} from './rate-limit.js'
import { createRequestTimeoutMiddleware, type RequestTimeoutOptions } from './request-timeout.js'
import { registerDeskRoutes } from './desk.js'
import { customerEvent, customerRun } from './customer-view.js'
import { customerRefundProgress } from './customer-progress.js'
import { localModelOrigin, type ModelSettingsStore } from './model-settings.js'
import { P7Error } from '@aftersales/contracts'

export interface AppDependencies {
  /** 部署探针仅检查依赖 不执行模型或资金动作 */
  readiness?: () => Promise<boolean>
  shutdownSignal?: AbortSignal
  system: ComposedSystem
  authEnv?: AuthEnv
  /** 模型不可用时创建运行返回 503 */
  modelAvailable: boolean
  modelSettings?: ModelSettingsStore
  /** false 关闭限流 对象可覆盖阈值 测试默认关闭 */
  rateLimit?: false | RateLimitOptions
  requestTimeout?: false | RequestTimeoutOptions
  sseMaxLifetimeMs?: number
  sseMaxConnections?: number
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
  const inTest = process.env.VITEST === 'true'
  const rateLimitEnabled = deps.rateLimit === false ? false : Boolean(deps.rateLimit) || !inTest
  const timeoutEnabled =
    deps.requestTimeout === false ? false : Boolean(deps.requestTimeout) || !inTest
  const sseGate = new ConnectionGate(deps.sseMaxConnections ?? 4)
  const approvalExecutions = new SqliteApprovalExecutionRepository(system.db)

  // 后台执行中的运行 进程内单飞锁 防止同一运行被并发驱动 单实例部署假设
  const executingRuns = new Map<string, Promise<void>>()

  /**
   * 运行提交后立即返回 事件经 SSE 实时推送
   * 循环内的模型错误由 failRun 兜底 这里兜状态机之外的意外异常
   * 返回 false 表示该运行已有后台任务占用 调用方应拒绝而非静默丢弃
   */
  const executeInBackground = (runId: string, task: () => Promise<unknown>): boolean => {
    if (executingRuns.has(runId)) return false
    const execution = (async () => {
      try {
        await task()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`运行 ${runId} 后台执行异常`, error)
        try {
          const run = await system.runService.get(runId)
          // 状态机允许的路径尽量落到 failed awaiting_* 无法转 failed
          // 以事件如实告知客户端 并保留状态供断点恢复救援
          if (run.status === 'created') {
            await system.runService.transition(runId, 'running')
          }
          if (run.status === 'created' || run.status === 'running') {
            await system.runService.transition(runId, 'failed', { error: message })
          }
          await system.runService.emit(runId, 'run.failed', {
            errorCode: 'INTERNAL_ERROR',
            message,
          })
        } catch (persistError) {
          console.error(`运行 ${runId} 失败终态落库异常`, persistError)
        }
      } finally {
        executingRuns.delete(runId)
      }
    })()
    executingRuns.set(runId, execution)
    return true
  }

  // L2 模拟评测后台任务表 进程内状态 重启即清空
  // 单实例部署假设下足够 任务串行推进避免中转站限流叠加
  const simTasks = new Map<
    string,
    {
      status: 'running' | 'done' | 'error'
      progress: SimSuiteProgress | null
      reportId: string | null
      error: string | null
      startedAt: string
    }
  >()
  const simCancellations = new Map<string, AbortController>()

  app.use('*', async (context, next) => {
    context.set('authEnv', authEnv)
    await next()
  })
  app.use('/api/*', cors())
  app.use('/api/*', async (context, next) => {
    if (deps.shutdownSignal?.aborted) return context.json({ status: 'stopping' }, 503)
    await next()
  })

  // 根路径返回服务引导信息 浏览器直接访问不再 404
  app.get('/', (context) => {
    return context.json({
      service: 'AfterSales Copilot API',
      message: '这是纯 API 服务 请打开工作台前端使用',
      workbench: 'http://localhost:8790',
      docs: 'GET /api/health 健康检查 其余接口见 README 的 API 一览 需要演示令牌',
    })
  })

  // 健康检查公开 不要求令牌 注册在认证中间件之前
  app.get('/api/health', (context) => {
    return context.json({
      status: 'ok',
      modelAvailable: deps.modelAvailable || Boolean(system.conversations),
      conversationMode: system.conversations
        ? system.durableBusiness
          ? 'durable_refund_simulation'
          : 'durable_readonly_simulation'
        : 'legacy',
      promptVersion: PROMPT_VERSION,
      modelTransport: deps.modelSettings?.status().enabled ? 'live' : 'simulation',
    })
  })

  app.get('/api/ready', async (context) => {
    try {
      system.db.prepare('SELECT 1').get()
      const ready = deps.readiness ? await deps.readiness() : true
      return context.json({ status: ready ? 'ready' : 'unavailable' }, ready ? 200 : 503)
    } catch {
      return context.json({ status: 'unavailable' }, 503)
    }
  })

  app.use('/api/*', requireActor)
  if (rateLimitEnabled) {
    app.use(
      '/api/*',
      createRateLimitMiddleware(deps.rateLimit === false ? {} : (deps.rateLimit ?? {})),
    )
  }
  if (timeoutEnabled) {
    app.use(
      '/api/*',
      createRequestTimeoutMiddleware(
        deps.requestTimeout === false ? {} : (deps.requestTimeout ?? {}),
      ),
    )
  }
  registerDeskRoutes(app, system)

  const localModelAccess = (context: Context<AppEnv>) =>
    localModelOrigin(context.req.header('Origin')) &&
    Boolean(deps.modelSettings?.authorized(context.req.header('X-Model-Local-Token')))

  const localCustomerModelAccess = (context: Context<AppEnv>) =>
    localModelAccess(context) ||
    Boolean(
      context.req.header('Origin') &&
      localModelOrigin(context.req.header('Origin')) &&
      deps.modelSettings?.usesEnvironmentKey(),
    )

  app.get('/api/model-settings', (context) => {
    if (!requireRole(context, ['supervisor']))
      return context.json({ error: 'AUTHORIZATION_DENIED' }, 403)
    if (!deps.modelSettings) return context.json({ error: 'MODEL_UNAVAILABLE' }, 503)
    context.header('Cache-Control', 'no-store')
    return context.json(deps.modelSettings.status())
  })

  app.post('/api/model-settings/test', async (context) => {
    if (!requireRole(context, ['supervisor']) || !localModelAccess(context))
      return context.json({ error: 'AUTHORIZATION_DENIED' }, 403)
    if (!deps.modelSettings) return context.json({ error: 'MODEL_UNAVAILABLE' }, 503)
    try {
      const result = await deps.modelSettings.test(await context.req.json())
      return context.json(result)
    } catch (error) {
      const code = error instanceof P7Error ? error.code : 'CONFIG'
      return context.json(
        {
          error: 'MODEL_TEST_FAILED',
          code,
          message:
            code === 'UPSTREAM'
              ? '模型服务暂时不可用 请稍后重试'
              : code === 'RATE_LIMITED'
                ? '模型服务请求过多 请稍后重试'
                : code === 'TRUNCATED'
                  ? '模型回复超出测试长度 请调整模型后重试'
                  : '模型测试未通过 请核对地址 密钥 模型和价格',
        },
        400,
      )
    }
  })

  app.put('/api/model-settings', async (context) => {
    if (!requireRole(context, ['supervisor']) || !localModelAccess(context))
      return context.json({ error: 'AUTHORIZATION_DENIED' }, 403)
    if (!deps.modelSettings) return context.json({ error: 'MODEL_UNAVAILABLE' }, 503)
    try {
      return context.json(deps.modelSettings.enable(await context.req.json()))
    } catch {
      return context.json({ error: 'CONFIG', message: '请先使用相同配置通过连接测试' }, 400)
    }
  })

  app.delete('/api/model-settings', (context) => {
    if (!requireRole(context, ['supervisor']) || !localModelAccess(context))
      return context.json({ error: 'AUTHORIZATION_DENIED' }, 403)
    if (!deps.modelSettings) return context.json({ error: 'MODEL_UNAVAILABLE' }, 503)
    return context.json(deps.modelSettings.disable())
  })

  // ---------- 运行管理 ----------

  // 客户申请与坐席接管分离 模型停用也能持久受理人工需求
  app.post('/api/human-help', async (context) => {
    const actor = context.get('actor') as Actor
    if (actor.role !== 'customer' || !actor.customerId)
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '仅客户可申请人工帮助' }, 403)
    const body = RequestHumanHelp.safeParse(await context.req.json().catch(() => null))
    if (!body.success)
      return context.json({ error: 'VALIDATION_ERROR', message: '请求体不合法' }, 400)
    if (!system.conversations)
      return context.json({ error: 'UNAVAILABLE', message: '人工受理入口暂不可用' }, 503)
    try {
      const task = system.conversations.control(
        actor.customerId,
        context.req.header('Idempotency-Key') ?? '',
        'human',
        body.data.sourceRunId,
      )
      return context.json({ runId: task.runId, accepted: true }, 202)
    } catch (error) {
      const mapped = errorResponse(error)
      if (mapped) return context.json(mapped.body, mapped.status)
      throw error
    }
  })

  // 创建会话先保存客户输入 持久模式由后台继续处理
  app.post('/api/runs', async (context) => {
    if (!deps.modelAvailable && !system.conversations) {
      return context.json(
        {
          error: 'MODEL_UNAVAILABLE',
          message: '真实模型对话入口已关闭 请使用显式持久离线模拟模式',
        },
        503,
      )
    }
    const actor = context.get('actor') as Actor
    // 结构校验只确认输入形状 订单归属和退款资格仍由业务层检查
    const body = CreateRunRequest.safeParse(await context.req.json())
    if (!body.success) {
      return context.json({ error: 'VALIDATION_ERROR', message: '请求体不合法' }, 400)
    }
    // 客户不能用请求体替换本人身份 团队代建才读取目标客户号
    const customerId = actor.role === 'customer' ? actor.customerId : body.data.customerId
    if (!customerId) {
      return context.json(
        { error: 'VALIDATION_ERROR', message: '操作员创建运行必须指定 customerId' },
        400,
      )
    }

    if (system.conversations) {
      // 重试原消息沿用原键 新消息使用新键 后端还会比较原始内容
      const key = context.req.header('Idempotency-Key') ?? ''
      try {
        if (body.data.modelMode === 'live' && !localCustomerModelAccess(context))
          return context.json({ error: 'AUTHORIZATION_DENIED' }, 403)
        const snapshot =
          body.data.modelMode === 'live' ? deps.modelSettings?.liveSnapshot() : undefined
        if (body.data.modelMode === 'live' && !snapshot)
          return context.json({ error: 'MODEL_UNAVAILABLE' }, 503)
        const task = system.conversations.accept(
          customerId,
          key,
          body.data.message,
          undefined,
          undefined,
          snapshot,
        )
        // 这些标识只证明输入和任务已保存 尚不证明建单或退款成功
        return context.json(
          { runId: task.runId, commandId: task.commandId, taskId: task.taskId, accepted: true },
          202,
        )
      } catch (error) {
        if (error instanceof P7Error)
          return context.json({ error: 'MODEL_UNAVAILABLE', message: '真实模型配置不可用' }, 503)
        const mapped = errorResponse(error)
        if (mapped) return context.json(mapped.body, mapped.status)
        throw error
      }
    }

    // 未装配持久会话才走兼容入口 两条路径的返回契约不同
    const run = await system.runService.start({
      customerId,
      promptVersion: PROMPT_VERSION,
      model: deps.system.runner ? 'configured' : 'none',
    })
    // 立即返回 runId 运行在后台推进 事件经 SSE 实时可见 客户端先订事件再提交亦可
    executeInBackground(run.runId, () =>
      system.runner.start(run.runId, body.data.message, {
        actor: { role: 'customer', customerId },
        runId: run.runId,
        faults: null,
      }),
    )
    return context.json({ runId: run.runId }, 201)
  })

  app.get('/api/runs', async (context) => {
    const actor = context.get('actor') as Actor
    const status = context.req.query('status')
    // 查询时就限制客户范围 不把其他客户数据交给浏览器过滤
    const runs = await system.runService.list({
      status,
      customerId: actor.role === 'customer' ? actor.customerId : undefined,
      limit: 50,
    })
    return context.json({ runs: actor.role === 'customer' ? runs.map(customerRun) : runs })
  })

  app.get('/api/runs/:runId', async (context) => {
    const actor = context.get('actor') as Actor
    const runId = context.req.param('runId')
    const run = await system.runService.get(runId)
    if (actor.role === 'customer' && run.customerId !== actor.customerId) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '无权访问该会话' }, 403)
    }
    return context.json({ run: actor.role === 'customer' ? customerRun(run) : run })
  })

  // 先检查本人会话 再读取原售后白名单进度
  app.get('/api/runs/:runId/customer-progress', async (context) => {
    const actor = context.get('actor') as Actor
    const run = await system.runService.get(context.req.param('runId'))
    if (actor.role !== 'customer' || run.customerId !== actor.customerId)
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '无权访问该客户进度' }, 403)
    context.header('Cache-Control', 'no-store')
    try {
      return context.json({ progress: customerRefundProgress(system.db, run, system.clock.now()) })
    } catch {
      return context.json(
        { error: 'PROGRESS_UNAVAILABLE', message: '进度暂时无法核验 请稍后重试' },
        503,
      )
    }
  })

  // 同一入口包含补问 留言和寄回 各分支成功的业务含义不同
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
    // 显式结束不调用模型 也不允许借此结束人工案件或退款流程
    if (body.data.action === 'end_consultation') {
      if (actor.role !== 'customer' || !actor.customerId)
        return context.json({ error: 'AUTHORIZATION_DENIED', message: '仅客户可结束咨询' }, 403)
      if (body.data.returnShipment || !system.conversations)
        return context.json({ error: 'CONFLICT', message: '当前会话不能结束咨询' }, 409)
      try {
        const task = system.conversations.control(
          actor.customerId,
          context.req.header('Idempotency-Key') ?? '',
          'end_consultation',
          runId,
        )
        return context.json({ runId: task.runId, accepted: true }, 202)
      } catch (error) {
        const mapped = errorResponse(error)
        if (mapped) return context.json(mapped.body, mapped.status)
        throw error
      }
    }
    // 明确转接文字与按钮使用同一路径 办理中的原任务不会因转接被覆盖
    if (
      actor.role === 'customer' &&
      actor.customerId &&
      system.conversations &&
      run.status !== 'handling_human' &&
      !body.data.returnShipment &&
      requestsHuman(body.data.message)
    ) {
      try {
        const task = system.conversations.control(
          actor.customerId,
          context.req.header('Idempotency-Key') ?? '',
          'human',
          runId,
        )
        return context.json({ runId: task.runId, accepted: true }, 202)
      } catch (error) {
        const mapped = errorResponse(error)
        if (mapped) return context.json(mapped.body, mapped.status)
        throw error
      }
    }
    // 人工处理中 客户消息直接落事件 不驱动模型 坐席端经 SSE 实时可见
    if (run.status === 'handling_human') {
      if (actor.role !== 'customer') {
        return context.json(
          { error: 'CONFLICT', message: '人工会话中仅客户可走消息端点 坐席请使用坐席消息端点' },
          409,
        )
      }
      // 人工接管后拒绝结构化寄回 防止普通留言成功冒充登记成功
      if (body.data.returnShipment) {
        return context.json(
          { error: 'CONFLICT', message: '会话已由人工接管 无法在此登记寄回 请联系坐席核验' },
          409,
        )
      }
      try {
        await system.handoverService.appendCustomerMessage(actor, runId, body.data.message)
      } catch (error) {
        const mapped = errorResponse(error)
        if (mapped) return context.json(mapped.body, mapped.status)
        throw error
      }
      return context.json({ runId })
    }
    // 已接管业务不能退回旧模型续跑 避免重新规划原退款
    if (system.durableBusiness?.owns(runId) && !system.conversations?.owns(runId))
      return context.json(
        { error: 'CONFLICT', message: '该业务已由持久任务接管 请从运营入口处理寄回与收货' },
        409,
      )
    if (system.conversations?.owns(runId)) {
      if (deps.modelSettings?.isLiveRun(runId) && !localCustomerModelAccess(context))
        return context.json({ error: 'AUTHORIZATION_DENIED' }, 403)
      try {
        const task = system.conversations.accept(
          run.customerId,
          context.req.header('Idempotency-Key') ?? '',
          body.data.message,
          runId,
          body.data.returnShipment,
        )
        // 补充或寄回受理后应刷新业务进度 不能直接显示退款成功
        return context.json({ runId: task.runId, commandId: task.commandId, accepted: true }, 202)
      } catch (error) {
        const mapped = errorResponse(error)
        if (mapped) return context.json(mapped.body, mapped.status)
        throw error
      }
    }
    // 同步预检 等待输入之外的续跑一律 409 与 runner 内部校验同源（RUN_TRANSITIONS）
    if (run.status !== 'awaiting_input') {
      return context.json(
        { error: 'CONFLICT', message: `会话状态 ${run.status} 不在接受补问` },
        409,
      )
    }
    if (
      !executeInBackground(runId, () =>
        system.runner.continueWithMessage(runId, body.data.message, {
          actor: { role: 'customer', customerId: run.customerId },
          runId,
          faults: null,
        }),
      )
    ) {
      return context.json({ error: 'CONFLICT', message: '会话正在处理中 请稍后再试' }, 409)
    }
    return context.json({ runId })
  })

  app.post('/api/runs/:runId/resume', async (context) => {
    if (!requireRole(context, ['operator', 'supervisor'])) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '仅操作员可执行断点恢复' }, 403)
    }
    const runId = context.req.param('runId')
    if (system.conversations?.owns(runId) || system.durableBusiness?.owns(runId))
      return context.json(
        { error: 'CONFLICT', message: '持久会话由 Worker 恢复 不使用旧恢复入口' },
        409,
      )
    const run = await system.runService.get(runId)
    // 审批和人工处理必须走专用入口 避免通用恢复抢占已受理的审批执行
    if (run.status !== 'running') {
      return context.json(
        { error: 'CONFLICT', message: `会话状态 ${run.status} 无可恢复的断点` },
        409,
      )
    }
    if (
      !executeInBackground(runId, () =>
        system.runner.resumeFromCheckpoint(runId, {
          actor: { role: 'customer', customerId: run.customerId },
          runId,
          faults: null,
        }),
      )
    ) {
      return context.json({ error: 'CONFLICT', message: '会话正在处理中 请稍后再试' }, 409)
    }
    return context.json({ runId })
  })

  // ---------- 人工接管 ----------

  app.post('/api/runs/:runId/handover', async (context) => {
    if (!requireRole(context, ['operator', 'supervisor'])) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '仅操作员可接管会话' }, 403)
    }
    const actor = context.get('actor') as Actor
    const runId = context.req.param('runId')
    try {
      await system.handoverService.takeOver(actor, runId)
    } catch (error) {
      const mapped = errorResponse(error)
      if (mapped) return context.json(mapped.body, mapped.status)
      throw error
    }
    return context.json({ runId, status: 'handling_human' })
  })

  app.post('/api/runs/:runId/operator-messages', async (context) => {
    if (!requireRole(context, ['operator', 'supervisor'])) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '仅操作员可发送坐席消息' }, 403)
    }
    const actor = context.get('actor') as Actor
    const runId = context.req.param('runId')
    const body = OperatorMessageRequest.safeParse(await context.req.json())
    if (!body.success) {
      return context.json({ error: 'VALIDATION_ERROR', message: '请求体不合法' }, 400)
    }
    try {
      await system.handoverService.appendOperatorMessage(actor, runId, body.data.message)
    } catch (error) {
      const mapped = errorResponse(error)
      if (mapped) return context.json(mapped.body, mapped.status)
      throw error
    }
    return context.json({ runId })
  })

  app.post('/api/runs/:runId/resolve', async (context) => {
    if (!requireRole(context, ['operator', 'supervisor'])) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '仅操作员可标记解决' }, 403)
    }
    const actor = context.get('actor') as Actor
    const runId = context.req.param('runId')
    const body = RunResolveRequest.safeParse(await context.req.json().catch(() => null))
    if (!body.success) {
      return context.json({ error: 'VALIDATION_ERROR', message: '请求体不合法' }, 400)
    }
    try {
      await system.handoverService.resolve(actor, runId, body.data.summary)
    } catch (error) {
      const mapped = errorResponse(error)
      if (mapped) return context.json(mapped.body, mapped.status)
      throw error
    }
    return context.json({ runId, status: 'completed' })
  })

  // ---------- 满意度与运营分析 ----------

  app.post('/api/runs/:runId/rating', async (context) => {
    const actor = context.get('actor') as Actor
    const runId = context.req.param('runId')
    const body = RunRatingRequest.safeParse(await context.req.json())
    if (!body.success) {
      return context.json({ error: 'VALIDATION_ERROR', message: '请求体不合法' }, 400)
    }
    try {
      const rating = await system.ratingService.submit(actor, runId, body.data)
      return context.json({ rating }, 201)
    } catch (error) {
      const mapped = errorResponse(error)
      if (mapped) return context.json(mapped.body, mapped.status)
      throw error
    }
  })

  app.get('/api/runs/:runId/rating', async (context) => {
    const actor = context.get('actor') as Actor
    const runId = context.req.param('runId')
    const run = await system.runService.get(runId)
    if (actor.role === 'customer' && run.customerId !== actor.customerId) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '无权访问该会话' }, 403)
    }
    const rating = await system.ratingService.findByRunId(runId)
    return context.json({ rating })
  })

  app.get('/api/analytics/overview', async (context) => {
    if (!requireRole(context, ['operator', 'supervisor'])) {
      return context.json(
        { error: 'AUTHORIZATION_DENIED', message: '仅内部人员可查看运营分析' },
        403,
      )
    }
    const days = Math.min(Math.max(Number(context.req.query('days') ?? 14) || 14, 1), 90)
    const overview = await system.analyticsService.overview(days)
    return context.json({
      ...overview,
      days,
      scopeNote: '仅聚合真实客户会话 source=customer 评测与模拟会话不计入',
    })
  })

  // ---------- 事件流 ----------

  app.get('/api/runs/:runId/events', async (context) => {
    const actor = context.get('actor') as Actor
    const runId = context.req.param('runId')
    const run = await system.runService.get(runId)
    if (actor.role === 'customer' && run.customerId !== actor.customerId) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '无权访问该会话' }, 403)
    }

    const lastEventId = Number(context.req.header('Last-Event-ID') ?? 0)
    if (!Number.isSafeInteger(lastEventId) || lastEventId < 0) {
      return context.json({ error: 'VALIDATION_ERROR', message: '事件游标不合法' }, 400)
    }
    const streamKey = actorKey(actor)
    if (!sseGate.tryAcquire(streamKey)) {
      context.header('Retry-After', '5')
      return context.json({ error: 'RATE_LIMITED', message: '事件流连接过多 请稍后重试' }, 429)
    }
    const stream = createEventStream(
      {
        signal: deps.shutdownSignal,
        listEvents: (id, from) => deps.system.eventRepo.listByRun(id, from, 200),
        projectEvent: actor.role === 'customer' ? customerEvent : undefined,
        getRunStatus: async (id) => (await system.runService.get(id)).status,
        isRunTerminal: async (id) => {
          const current = await system.runService.get(id)
          // escalated 已非终态 可被坐席接管 事件流保持打开等待 run.handover
          return (
            !executingRuns.has(id) && ['completed', 'failed', 'cancelled'].includes(current.status)
          )
        },
        maxLifetimeMs: deps.sseMaxLifetimeMs ?? (inTest ? undefined : 15 * 60 * 1000),
        onClose: () => sseGate.release(streamKey),
      },
      runId,
      lastEventId,
    )
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        // 禁止代理压缩转换 防止长连接只发压缩头而积压业务帧
        'Cache-Control': 'no-cache, no-transform',
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
    return context.json({
      events:
        actor.role === 'customer'
          ? events.flatMap((event) => {
              const visible = customerEvent(event)
              return visible ? [visible] : []
            })
          : events,
    })
  })

  // ---------- 审批 ----------

  // 执行记录与审批决定分开展示 完成仅代表恢复调用结束而非退款一定成功
  app.get('/api/approvals/executions', (context) => {
    if (!requireRole(context, ['operator', 'supervisor'])) {
      return context.json(
        { error: 'AUTHORIZATION_DENIED', message: '仅内部人员可查看执行记录' },
        403,
      )
    }
    return context.json({
      executions: new SqliteApprovalProgressRepository(system.db).list(),
      limit: 100,
    })
  })

  app.get('/api/approvals', async (context) => {
    if (!requireRole(context, ['operator', 'supervisor'])) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '仅内部人员可查看审批' }, 403)
    }
    const pending = await system.approvalService.listPending()
    return context.json({
      approvals: pending.map(({ oneTimeToken: _token, ...approval }) => approval),
    })
  })

  app.post('/api/runs/:runId/approvals/:approvalId/decide', async (context) => {
    if (!requireRole(context, ['supervisor'])) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '审批决定仅限主管' }, 403)
    }
    const runId = context.req.param('runId')
    const approvalId = context.req.param('approvalId')
    const actor = context.get('actor') as Actor
    const body = ApprovalDecisionRequest.safeParse(await context.req.json().catch(() => null))
    if (!body.success) {
      return context.json({ error: 'VALIDATION_ERROR', message: '请求体不合法' }, 400)
    }
    // 审批归属与运行状态在写入决定前校验
    const run = await system.runService.get(runId)
    const linked = system.db
      .prepare(
        'SELECT run_id, resource_type, resource_id, amount_cents FROM approval_requests WHERE approval_id = ?',
      )
      .get(approvalId) as
      | { run_id: string | null; resource_type: string; resource_id: string; amount_cents: number }
      | undefined
    if (!linked || linked.run_id !== runId) {
      return context.json({ error: 'CONFLICT', message: '审批不属于当前会话' }, 409)
    }
    if (run.status !== 'awaiting_approval') {
      return context.json({ error: 'CONFLICT', message: '当前会话不在等待审批' }, 409)
    }
    if (executingRuns.has(runId)) {
      return context.json({ error: 'CONFLICT', message: '当前处理尚未暂停完成 请稍后重试' }, 409)
    }

    // 审批展示的资源与金额必须来自当前待恢复方案 并把断点版本带入写事务
    const checkpoint = system.db
      .prepare('SELECT id, state_json FROM checkpoints WHERE run_id = ? ORDER BY id DESC LIMIT 1')
      .get(runId) as { id: number; state_json: string } | undefined
    const state = checkpoint ? (JSON.parse(checkpoint.state_json) as Record<string, unknown>) : null
    const resourceType = state?.approvalResourceType ?? 'return_request'
    const resourceId =
      resourceType === 'compensation'
        ? state?.compensationNo
        : resourceType === 'price_protection'
          ? state?.protectionNo
          : state?.returnNo
    const amount = resourceType === 'compensation' ? state?.amountCents : state?.refundAmountCents

    if (
      !checkpoint ||
      state?.approvalId !== approvalId ||
      resourceType !== linked.resource_type ||
      resourceId !== linked.resource_id ||
      amount !== linked.amount_cents
    ) {
      return context.json(
        { error: 'CONFLICT', message: '审批与当前处理方案不一致 请重新核验' },
        409,
      )
    }
    // 检查点版本传到写入侧 防止读完方案后发生变化仍被批准
    const result = await system.approvalService.decide(
      actor,
      approvalId,
      body.data.decision,
      runId,
      checkpoint.id,
    )
    if (result.outcome === 'already_decided') {
      return context.json({ error: 'CONFLICT', message: '该审批已处理过 不能重复决定' }, 409)
    }
    if (result.outcome === 'expired') {
      return context.json({ error: 'APPROVAL_EXPIRED', message: '审批已过期' }, 409)
    }
    if (result.outcome === 'conflict') {
      return context.json({ error: 'CONFLICT', message: '审批归属或运行状态已变化' }, 409)
    }

    // 决定与执行意图已在同一事务提交 内存调度丢失时仍能查到待处理记录
    if (system.durableBusiness) {
      // 持久扫描接手意图 此模式不能再启动旧审批恢复执行器
      return context.json(
        { runId, approvalId, decision: body.data.decision, executionStatus: 'pending' },
        202,
      )
    }
    executeInBackground(runId, async () => {
      if (!approvalExecutions.claim(approvalId, system.clock.now().toISOString())) return
      try {
        const outcome = await system.runner.resumeAfterApproval(
          runId,
          approvalId,
          result.approval.status as 'approved' | 'rejected',
          result.approval.decidedBy ?? actor.role,
          { actor: { role: 'customer', customerId: run.customerId }, runId, faults: null },
        )
        approvalExecutions.finish(
          approvalId,
          outcome === 'failed' ? 'failed' : 'completed',
          system.clock.now().toISOString(),
          outcome === 'failed' ? '运行恢复失败 请核查业务记录' : null,
        )
      } catch (error) {
        approvalExecutions.finish(
          approvalId,
          'failed',
          system.clock.now().toISOString(),
          error instanceof Error ? error.message : '运行恢复异常',
        )
        throw error
      }
    })
    return context.json({
      runId,
      approvalId,
      decision: body.data.decision,
      executionStatus: approvalExecutions.find(approvalId)?.status ?? 'pending',
    })
  })

  // ---------- 运营操作 ----------

  // 物流事件注入 会话中途推送物流状态变化 空闲即触达 忙时挂起下一轮
  app.post('/api/runs/:runId/logistics-events', async (context) => {
    if (!requireRole(context, ['operator', 'supervisor'])) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '仅操作员可注入物流事件' }, 403)
    }
    const actor = context.get('actor') as Actor
    const runId = context.req.param('runId')
    if (system.conversations?.owns(runId) || system.durableBusiness?.owns(runId))
      return context.json(
        { error: 'CONFLICT', message: '持久会话暂不支持主动物流事件 请通过客户补充消息查询' },
        409,
      )
    const body = LogisticsEventInjectRequest.safeParse(await context.req.json())
    if (!body.success) {
      return context.json({ error: 'VALIDATION_ERROR', message: '请求体不合法' }, 400)
    }
    try {
      const event = await system.logisticsService.inject(actor, {
        orderNo: body.data.orderNo,
        status: body.data.status,
        description: body.data.description,
        eventId: body.data.eventId ?? `op_${Date.now().toString(36)}`,
        source: 'operator',
        runId,
      })
      // 混合到达语义不变量 事件无论会话状态一律落表 时间线可回放
      // 运行占用中必为忙时路径 落表后挂起下一轮 同步返回不会驱动循环
      const run = await system.runService.get(runId)
      const toolContext = {
        actor: { role: 'customer' as const, customerId: run.customerId },
        runId,
        faults: null,
      }
      const delivered = run.status === 'awaiting_input'
      if (executingRuns.has(runId)) {
        const result = await system.runner.processLogisticsEvent(runId, event, toolContext)
        return context.json({
          runId,
          event: {
            orderNo: event.orderNo,
            status: event.status,
            description: event.description,
            eventId: event.eventId,
            injectedAt: event.injectedAt,
          },
          delivered: result.delivered,
          outcome: null,
        })
      }
      executeInBackground(runId, () =>
        system.runner.processLogisticsEvent(runId, event, toolContext),
      )
      return context.json({
        runId,
        event: {
          orderNo: event.orderNo,
          status: event.status,
          description: event.description,
          eventId: event.eventId,
          injectedAt: event.injectedAt,
        },
        delivered,
        outcome: null,
      })
    } catch (error) {
      const mapped = errorResponse(error)
      if (mapped) return context.json(mapped.body, mapped.status)
      throw error
    }
  })

  // 客户登记运单不等于卖家收货 收货角色限制在此入口执行
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
      if (system.durableBusiness) {
        const task = system.durableBusiness.receive(returnNo)
        return context.json({ accepted: true, taskId: task.taskId, runId: task.runId }, 202)
      }
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

  app.post('/api/operations/return-shipment', async (context) => {
    if (!requireRole(context, ['operator', 'supervisor']))
      return context.json({ error: 'AUTHORIZATION_DENIED' }, 403)
    const body = (await context.req.json().catch(() => null)) as {
      returnNo?: unknown
      trackingNo?: unknown
    } | null
    if (
      typeof body?.returnNo !== 'string' ||
      !body.returnNo.trim() ||
      typeof body.trackingNo !== 'string' ||
      !body.trackingNo.trim() ||
      body.trackingNo.length > 100
    )
      return context.json({ error: 'VALIDATION_ERROR', message: '售后单号与寄回单号必填' }, 400)
    const result = await system.afterSaleService.recordReturnShipment(
      context.get('actor'),
      body.returnNo,
      body.trackingNo,
    )
    return context.json({ result })
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
    // 独立业务夹具不清空共享账本 所有脚本模型调用也经过同一预算入口
    const result = await runBudgetedL1(EVAL_CASES, 1, {
      db: system.db,
      experimentId: `eval-${randomUUID()}`,
      roles: offlineEvalRoles,
    })
    const { report } = result
    // 与 CLI 一致落库 看板对比列与历史表即时可见
    saveEvalReport(system.db, {
      reportId: report.reportId,
      startedAt: report.startedAt,
      model: report.model,
      promptVersion: report.promptVersion,
      total: report.total,
      passed: report.passed,
      failed: report.failed,
      gatePassed: report.gatePassed,
      report,
    })
    saveP7EvalEvidence(system.db, result)
    return context.json({
      reportId: report.reportId,
      total: report.total,
      passed: report.passed,
      gatePassed: report.gatePassed,
      mode: 'simulation',
      experimentId: result.evidence.experimentId,
    })
  })

  // L2 用户模拟评测 后台任务 启动后轮询进度
  app.post('/api/eval/run-sim', async (context) => {
    if (!requireRole(context, ['operator', 'supervisor'])) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '仅内部人员可触发评测' }, 403)
    }
    const body = (await context.req.json().catch(() => ({}))) as {
      mode?: string
      caseId?: string
      sample?: 'p0' | 'p1' | 'p2' | 'all'
      repeat?: number
      agentModel?: string
      userModel?: string
      judgeModel?: string
    }
    if (body.mode !== 'simulation')
      return context.json(
        {
          error: 'LIVE_DISABLED',
          message: '真实评测未开放 请显式指定 simulation 进行离线通路验收',
        },
        503,
      )
    if ([body.agentModel, body.userModel, body.judgeModel].some((value) => value !== undefined))
      return context.json({ error: 'BAD_REQUEST', message: '离线入口不接受供应商模型覆盖' }, 400)
    const options = {
      sample: body.sample ?? 'p0',
      repeat: Number(body.repeat ?? 1),
      caseId: body.caseId,
      agentModel: 'offline-main_agent',
      userModel: 'offline-simulator',
      judgeModel: 'offline-judge',
    }
    if (!Number.isSafeInteger(options.repeat) || options.repeat < 1 || options.repeat > 5)
      return context.json({ error: 'BAD_REQUEST', message: 'repeat 必须为一至五的整数' }, 400)
    if (
      options.sample !== 'p0' &&
      options.sample !== 'p1' &&
      options.sample !== 'p2' &&
      options.sample !== 'all'
    ) {
      return context.json(
        { error: 'BAD_REQUEST', message: 'sample 参数需为 p0 p1 p2 all 之一' },
        400,
      )
    }

    // 已有任务在跑 拒绝并发启动 避免中转站限流叠加
    for (const task of simTasks.values()) {
      if (task.status === 'running') {
        return context.json(
          { error: 'CONFLICT', message: '已有 L2 评测任务运行中 请等待完成' },
          409,
        )
      }
    }

    const taskId = `sim_${randomUUID()}`
    const cases = selectCases(options.sample, options.caseId)
    const cancellation = new AbortController()
    simCancellations.set(taskId, cancellation)
    const startedAt = new Date().toISOString()
    simTasks.set(taskId, {
      status: 'running',
      progress: null,
      reportId: null,
      error: null,
      startedAt,
    })

    // 后台执行 不阻塞响应 失败落任务表 供轮询读取
    void (async () => {
      try {
        const result = await runSimSuite({
          ...options,
          budget: {
            db: system.db,
            experimentId: taskId,
            roles: offlineEvalRoles,
            signal: cancellation.signal,
          },
          onProgress: (progress) => {
            const task = simTasks.get(taskId)
            if (task) task.progress = progress
          },
        })
        const { report } = result
        saveEvalReport(system.db, {
          reportId: report.reportId,
          startedAt: report.startedAt,
          model: report.model,
          promptVersion: report.promptVersion,
          total: report.total,
          passed: report.passed,
          failed: report.failed,
          gatePassed: report.gatePassed,
          report,
        })
        saveP7EvalEvidence(system.db, result)
        const task = simTasks.get(taskId)
        if (task) {
          task.status = 'done'
          task.reportId = report.reportId
        }
      } catch (error) {
        const task = simTasks.get(taskId)
        if (task) {
          task.status = 'error'
          task.error = error instanceof Error ? error.message : String(error)
        }
      } finally {
        simCancellations.delete(taskId)
      }
    })()

    return context.json({
      taskId,
      totalCases: cases.length,
      estimatedTokens: estimateSuiteTokens(cases.length, options.repeat),
      startedAt,
      mode: 'simulation',
    })
  })

  app.get('/api/eval/sim-tasks/:taskId', async (context) => {
    if (!requireRole(context, ['operator', 'supervisor'])) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '仅内部人员可查看评测' }, 403)
    }
    const task = simTasks.get(context.req.param('taskId'))
    if (!task) {
      return context.json({ error: 'NOT_FOUND', message: '任务不存在或服务已重启' }, 404)
    }
    return context.json({ task })
  })

  app.post('/api/eval/sim-tasks/:taskId/cancel', (context) => {
    if (!requireRole(context, ['operator', 'supervisor']))
      return context.json({ error: 'AUTHORIZATION_DENIED' }, 403)
    const cancellation = simCancellations.get(context.req.param('taskId'))
    if (!cancellation) return context.json({ error: 'NOT_FOUND' }, 404)
    cancellation.abort(new Error('评测已取消'))
    return context.json({ accepted: true }, 202)
  })

  app.get('/api/eval/reports/:reportId/evidence', (context) => {
    if (!requireRole(context, ['operator', 'supervisor']))
      return context.json({ error: 'AUTHORIZATION_DENIED' }, 403)
    const evidence = readP7EvalEvidence(system.db, context.req.param('reportId'))
    return evidence ? context.json({ evidence }) : context.json({ error: 'NOT_FOUND' }, 404)
  })

  // 统一领域错误出口
  app.onError((error, context) => {
    if (error instanceof SourceIdentityError)
      return context.json({ error: 'SOURCE_IDENTITY_UNAVAILABLE', message: error.message }, 503)
    const mapped = errorResponse(error)
    if (mapped) {
      return context.json(mapped.body, mapped.status)
    }
    console.error('未处理异常', error)
    return context.json({ error: 'INTERNAL_ERROR', message: '服务内部错误' }, 500)
  })

  return app
}
