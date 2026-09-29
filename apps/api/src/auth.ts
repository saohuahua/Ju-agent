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

/** 集中读取团队演示凭据 客户凭据仍由固定映射提供 */
export function createAuthEnv(): AuthEnv {
  return {
    operatorToken: process.env.OPERATOR_TOKEN ?? 'operator-token',
    supervisorToken: process.env.SUPERVISOR_TOKEN ?? 'supervisor-token',
  }
}

/** 从请求解析操作身份 无凭据返回 null */
export function resolveActor(authorization: string | undefined, authEnv: AuthEnv): Actor | null {
  // 只有约定格式的凭据参与认证 消息正文和请求体不提供角色
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
  // 客户号由服务端映射得出 后续资源归属检查以此为准
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
  // 请求头存在时不再使用查询令牌 无效请求头也不能靠查询参数覆盖
  const authorization = headerToken ?? (queryToken ? `Bearer ${queryToken}` : undefined)
  const actor = resolveActor(authorization, authEnv)
  if (!actor) {
    return context.json({ error: 'UNAUTHORIZED', message: '请携带有效的 Bearer 令牌' }, 401)
  }
  // 身份写入请求上下文 路由再判断该身份能否访问具体资源
  context.set('actor', actor)
  await next()
  return undefined
}

/** 仅判断动作角色范围 不代表已通过订单或会话归属检查 */
export function requireRole(context: Context, roles: Actor['role'][]): boolean {
  const actor = context.get('actor') as Actor | undefined
  return Boolean(actor && roles.includes(actor.role))
}
