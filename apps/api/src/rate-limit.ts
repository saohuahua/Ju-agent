/**
 * 按身份与端点的固定窗口限流
 *
 * 单进程内存计数 与当前单写者部署一致
 * 命中后返回 429 并带 Retry-After 不写业务库
 */

import type { MiddlewareHandler } from 'hono'
import type { Actor } from '@aftersales/domain'

export interface RateLimitWindow {
  resetAt: number
  count: number
}

export interface RateLimitOptions {
  now?: () => number
  onBlock?: (info: { actorKey: string; group: string; limit: number; retryAfter: number }) => void
  createRunPerMinute?: number
  messagePerMinute?: number
  operatorWritePerMinute?: number
  evalPerMinute?: number
  readPerMinute?: number
}

const MINUTE = 60_000

export function actorKey(actor: Actor | undefined): string {
  if (!actor) return 'anonymous'
  if (actor.role === 'customer') return `customer:${actor.customerId ?? 'unknown'}`
  return actor.role
}

export function classifyRateLimit(
  method: string,
  path: string,
  options: RateLimitOptions = {},
): { group: string; limit: number; windowMs: number } | null {
  if (method === 'POST' && path === '/api/runs') {
    return { group: 'create-run', limit: options.createRunPerMinute ?? 5, windowMs: MINUTE }
  }
  if (method === 'POST' && /\/api\/runs\/[^/]+\/(messages|resume)$/.test(path)) {
    return { group: 'message', limit: options.messagePerMinute ?? 12, windowMs: MINUTE }
  }
  if (method === 'POST' && path.startsWith('/api/eval/')) {
    return { group: 'eval', limit: options.evalPerMinute ?? 2, windowMs: MINUTE }
  }
  if (method === 'POST') {
    return { group: 'write', limit: options.operatorWritePerMinute ?? 60, windowMs: MINUTE }
  }
  if (method === 'GET' && /\/api\/runs\/[^/]+\/events$/.test(path)) return null
  if (method === 'GET') {
    return { group: 'read', limit: options.readPerMinute ?? 240, windowMs: MINUTE }
  }
  return { group: 'other', limit: 60, windowMs: MINUTE }
}

export class ConnectionGate {
  private readonly counts = new Map<string, number>()
  constructor(private readonly max: number) {}

  tryAcquire(key: string): boolean {
    const current = this.counts.get(key) ?? 0
    if (current >= this.max) return false
    this.counts.set(key, current + 1)
    return true
  }

  release(key: string): void {
    const current = this.counts.get(key) ?? 0
    if (current <= 1) this.counts.delete(key)
    else this.counts.set(key, current - 1)
  }

  size(key: string): number {
    return this.counts.get(key) ?? 0
  }
}

export function createRateLimitMiddleware(options: RateLimitOptions = {}): MiddlewareHandler {
  const windows = new Map<string, RateLimitWindow>()
  const now = options.now ?? Date.now
  return async (context, next) => {
    const path = new URL(context.req.url).pathname
    const rule = classifyRateLimit(context.req.method, path, options)
    if (!rule) {
      await next()
      return
    }
    const key = `${actorKey(context.get('actor'))}:${rule.group}`
    const ts = now()
    const current = windows.get(key)
    if (!current || current.resetAt <= ts) {
      windows.set(key, { resetAt: ts + rule.windowMs, count: 1 })
      await next()
      return
    }
    if (current.count >= rule.limit) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - ts) / 1000))
      options.onBlock?.({
        actorKey: key,
        group: rule.group,
        limit: rule.limit,
        retryAfter,
      })
      context.header('Retry-After', String(retryAfter))
      return context.json(
        { error: 'RATE_LIMITED', message: `请求过于频繁 请 ${retryAfter} 秒后重试` },
        429,
      )
    }
    current.count += 1
    await next()
  }
}
