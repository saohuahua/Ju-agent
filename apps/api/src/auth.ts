/**
 * 认证中间件
 *
 * 演示环境令牌模型 生产环境应替换为正式认证体系
 * 令牌到身份的映射在这里收敛 路由只关心操作身份
 */

import type { Context, Next } from 'hono'
import type { Actor } from '@aftersales/domain'

/** 演示客户令牌与客户号的映射 生产环境必须替换 */
const DEMO_CUSTOMER_TOKENS: Record<string, string> = {
  'cust-token-1001': 'C1001',
  'cust-token-1002': 'C1002',
  'cust-token-1003': 'C1003',
}

export interface AuthEnv {
  operatorToken: string
  supervisorToken: string
}

export function createAuthEnv(): AuthEnv {
  return {
    operatorToken: process.env.OPERATOR_TOKEN ?? 'operator-token',
    supervisorToken: process.env.SUPERVISOR_TOKEN ?? 'supervisor-token',
  }
}

/** 从请求解析操作身份 无凭据返回 null */
export function resolveActor(authorization: string | undefined, authEnv: AuthEnv): Actor | null {
  if (!authorization?.startsWith('Bearer ')) {
    return null
  }
  const token = authorization.slice('Bearer '.length).trim()
  if (token === authEnv.supervisorToken) {
    return { role: 'supervisor' }
  }
  if (token === authEnv.operatorToken) {
    return { role: 'operator' }
  }
  const customerId = DEMO_CUSTOMER_TOKENS[token]
  if (customerId) {
    return { role: 'customer', customerId }
  }
  return null
}

/** 中间件 无有效身份一律 401 令牌优先取请求头 EventSource 场景退化为查询参数 */
export async function requireActor(context: Context, next: Next): Promise<Response | undefined> {
  const authEnv: AuthEnv = (context.get('authEnv') as AuthEnv | undefined) ?? createAuthEnv()
  const headerToken = context.req.header('Authorization')
  const queryToken = context.req.query('token')
  const authorization = headerToken ?? (queryToken ? `Bearer ${queryToken}` : undefined)
  const actor = resolveActor(authorization, authEnv)
  if (!actor) {
    return context.json({ error: 'UNAUTHORIZED', message: '请携带有效的 Bearer 令牌' }, 401)
  }
  context.set('actor', actor)
  await next()
  return undefined
}

/** 角色门槛 */
export function requireRole(context: Context, roles: Actor['role'][]): boolean {
  const actor = context.get('actor') as Actor | undefined
  return Boolean(actor && roles.includes(actor.role))
}
