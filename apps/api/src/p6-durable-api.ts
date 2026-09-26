import { Hono } from 'hono'
import type { Context } from 'hono'
import type { P6TaskRepository } from '../../../packages/persistence/src/p6-task-repository.js'
import type { P6CommandInput } from '../../../packages/contracts/src/p6-durable.js'
import { p6EventStream } from './p6-event-stream.js'

export interface P6ApiPorts {
  repository: P6TaskRepository
  /** 使用正式身份系统与资源归属校验 未授权返回空值 不从请求正文采信客户编号 */
  customer(context: Context): Promise<string | null>
  /** 只准备经过规则校验的计划 禁止在受理之前执行外部副作用 */
  prepare(body: Record<string, unknown>, customerId: string): Promise<P6CommandInput>
}

/**
 * 独立挂载的持久命令接口 返回受理前已经提交运行命令与任务
 * 正式路由集成前不替换现有入口 公开响应不暴露计划配置及内部错误
 */
export function createP6DurableApi(ports: P6ApiPorts): Hono {
  const app = new Hono()
  app.post('/commands', async (context) => {
    const customerId = await ports.customer(context)
    if (!customerId) return context.json({ error: 'UNAUTHORIZED' }, 401)
    const requestKey = context.req.header('Idempotency-Key')
    if (!requestKey || requestKey.length > 200)
      return context.json({ error: 'INVALID_REQUEST_KEY' }, 400)
    let body: Record<string, unknown>
    try {
      const value: unknown = await context.req.json()
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效正文')
      body = value as Record<string, unknown>
    } catch {
      return context.json({ error: 'INVALID_BODY' }, 400)
    }
    try {
      // 重复请求复用原计划 原配置发生全局切换也不能改变在途运行
      const previous = ports.repository.findRequest(customerId, requestKey)
      const prepared = previous?.input ?? (await ports.prepare(body, customerId))
      if (prepared.customerId !== customerId) return context.json({ error: 'FORBIDDEN' }, 403)
      const task = ports.repository.accept({ ...prepared, requestKey, requestPayload: body })
      return context.json(
        {
          commandId: task.commandId,
          taskId: task.taskId,
          runId: task.runId,
          status: task.status,
          accepted: true,
        },
        previous ? 200 : 202,
      )
    } catch {
      return context.json({ error: 'COMMAND_CONFLICT' }, 409)
    }
  })

  app.get('/commands/:taskId', async (context) => {
    const customerId = await ports.customer(context)
    const task = ports.repository.get(context.req.param('taskId'))
    if (!customerId) return context.json({ error: 'UNAUTHORIZED' }, 401)
    if (!task || task.customerId !== customerId) return context.json({ error: 'NOT_FOUND' }, 404)
    return context.json({
      taskId: task.taskId,
      runId: task.runId,
      status: task.status,
      cancelRequested: Boolean(task.cancelRequested),
    })
  })

  app.post('/commands/:taskId/cancel', async (context) => {
    const customerId = await ports.customer(context)
    if (!customerId) return context.json({ error: 'UNAUTHORIZED' }, 401)
    if (!ports.repository.cancel(context.req.param('taskId'), customerId)) {
      return context.json({ error: 'NOT_CANCELLABLE' }, 409)
    }
    return context.json({ accepted: true }, 202)
  })

  app.get('/commands/:taskId/events', async (context) => {
    const customerId = await ports.customer(context)
    if (!customerId) return context.json({ error: 'UNAUTHORIZED' }, 401)
    const task = ports.repository.get(context.req.param('taskId'))
    if (!task || task.customerId !== customerId) return context.json({ error: 'NOT_FOUND' }, 404)
    const cursor = Number(context.req.header('Last-Event-ID') ?? 0)
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      return context.json({ error: 'INVALID_CURSOR' }, 400)
    return new Response(p6EventStream(ports.repository, task.taskId, cursor), {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    })
  })

  // 工程事件仅投影公开进度 客户接口不公开检查点及工具结果
  return app
}
