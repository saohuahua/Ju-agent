/**
 * 请求级超时
 *
 * 只约束会结束的 HTTP 处理 GET 流式端点不走这里
 * 超时返回 503 后台任务可能仍在推进 客户端应查会话状态
 */

import type { MiddlewareHandler } from 'hono'

export interface RequestTimeoutOptions {
  postMs?: number
  evalMs?: number
}

export function createRequestTimeoutMiddleware(
  options: RequestTimeoutOptions = {},
): MiddlewareHandler {
  const postMs = options.postMs ?? 30_000
  const evalMs = options.evalMs ?? 600_000
  return async (context, next) => {
    if (context.req.method === 'GET' || context.req.method === 'HEAD') {
      await next()
      return
    }
    const path = new URL(context.req.url).pathname
    const limit = path.startsWith('/api/eval/') ? evalMs : postMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<Response>((resolve) => {
      timer = setTimeout(() => {
        resolve(context.json({ error: 'REQUEST_TIMEOUT', message: '请求处理超时' }, 503))
      }, limit)
    })
    try {
      const result = await Promise.race([next(), timeout])
      if (result instanceof Response) return result
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
