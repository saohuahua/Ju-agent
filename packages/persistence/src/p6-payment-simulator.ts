import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { SqliteDatabase } from './db.js'
import type { P6Payment, P6PaymentPort, P6PaymentResult } from '../../contracts/src/p6-durable.js'

export type P6PaymentFault = 'normal' | 'response_lost' | 'rejected' | 'unknown' | 'delayed'

/**
 * 本地模拟渠道使用独立数据库和进程 不读取业务库
 * 幂等键绑定金额币种和资源 响应丢失发生在渠道事务提交之后
 */
export function startP6PaymentSimulator(db: SqliteDatabase, port = 0): Promise<Server> {
  db.pragma('busy_timeout = 5000')
  db.exec(`CREATE TABLE IF NOT EXISTS p6_channel (
    business_key TEXT PRIMARY KEY, payment_json TEXT NOT NULL, status TEXT NOT NULL,
    transaction_id TEXT NOT NULL, submissions INTEGER NOT NULL, charges INTEGER NOT NULL
  ); CREATE TABLE IF NOT EXISTS p6_channel_faults (business_key TEXT PRIMARY KEY, mode TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS p6_channel_queries (id INTEGER PRIMARY KEY, business_key TEXT NOT NULL);`)
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      // 健康探针只读数据库 不创建查询记录或资金动作
      if (req.method === 'GET' && url.pathname === '/health') {
        db.prepare('SELECT 1 FROM p6_channel LIMIT 1').get()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', mode: 'simulation' }))
        return
      }
      let result: P6PaymentResult
      if (req.method === 'GET' && url.pathname === '/payments') {
        const key = url.searchParams.get('key') ?? ''
        db.prepare('INSERT INTO p6_channel_queries(business_key) VALUES (?)').run(key)
        const row = db
          .prepare(
            'SELECT status, transaction_id AS transactionId FROM p6_channel WHERE business_key = ?',
          )
          .get(key) as { status: string; transactionId: string } | undefined
        result = !row
          ? { status: 'not_found' }
          : row.status === 'succeeded'
            ? { status: 'succeeded', transactionId: row.transactionId }
            : row.status === 'rejected'
              ? { status: 'rejected', reason: '模拟渠道明确拒绝' }
              : { status: 'unknown', reason: '模拟渠道无法确认终态' }
      } else if (req.method === 'POST' && url.pathname === '/payments') {
        let body = ''
        for await (const chunk of req) {
          body += String(chunk)
          if (body.length > 8192) throw new Error('请求过大')
        }
        const payment = JSON.parse(body) as P6Payment
        if (
          typeof payment.businessKey !== 'string' ||
          !payment.businessKey ||
          typeof payment.resourceId !== 'string' ||
          typeof payment.currency !== 'string' ||
          !Number.isSafeInteger(payment.amountCents) ||
          payment.amountCents <= 0
        )
          throw new Error('无效金额或键')
        const serialized = JSON.stringify([
          payment.resourceId,
          payment.amountCents,
          payment.currency,
        ])
        const mode =
          (
            db
              .prepare('SELECT mode FROM p6_channel_faults WHERE business_key = ?')
              .get(payment.businessKey) as { mode: P6PaymentFault } | undefined
          )?.mode ?? 'normal'
        result = db
          .transaction((): P6PaymentResult => {
            const row = db
              .prepare('SELECT * FROM p6_channel WHERE business_key = ?')
              .get(payment.businessKey) as
              { payment_json: string; status: string; transaction_id: string } | undefined
            if (row && row.payment_json !== serialized) throw new Error('渠道幂等键冲突')
            if (!row) {
              const status =
                mode === 'rejected' ? 'rejected' : mode === 'unknown' ? 'unknown' : 'succeeded'
              db.prepare('INSERT INTO p6_channel VALUES (?,?,?,?,1,?)').run(
                payment.businessKey,
                serialized,
                status,
                randomUUID(),
                status === 'succeeded' ? 1 : 0,
              )
            } else
              db.prepare(
                'UPDATE p6_channel SET submissions = submissions + 1 WHERE business_key = ?',
              ).run(payment.businessKey)
            const saved = db
              .prepare('SELECT status, transaction_id AS id FROM p6_channel WHERE business_key = ?')
              .get(payment.businessKey) as { status: string; id: string }
            return saved.status === 'succeeded'
              ? { status: 'succeeded', transactionId: saved.id }
              : saved.status === 'rejected'
                ? { status: 'rejected', reason: '模拟渠道明确拒绝' }
                : { status: 'unknown', reason: '模拟渠道无法确认终态' }
          })
          .immediate()
        if (mode === 'response_lost') {
          req.socket.destroy()
          return
        }
        if (mode === 'delayed') await new Promise((resolve) => setTimeout(resolve, 500))
      } else {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : '模拟渠道异常' }))
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

/** 该适配器仅允许本机模拟渠道 非成功响应属于调用失败而非业务拒绝 */
export function p6PaymentClient(baseUrl: string): P6PaymentPort {
  const url = new URL(baseUrl)
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:')
    throw new Error('只允许本地模拟支付')
  async function request(
    path: string,
    signal: AbortSignal,
    payment?: P6Payment,
  ): Promise<P6PaymentResult> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: payment ? 'POST' : 'GET',
      signal,
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: payment ? JSON.stringify(payment) : undefined,
    })
    if (!response.ok) throw new Error(`模拟渠道调用失败 ${response.status}`)
    const result = (await response.json()) as P6PaymentResult
    if (
      !result ||
      !['succeeded', 'rejected', 'unknown', 'not_found'].includes(result.status) ||
      (result.status === 'succeeded' && typeof result.transactionId !== 'string') ||
      ((result.status === 'unknown' || result.status === 'rejected') &&
        typeof result.reason !== 'string')
    ) {
      throw new Error('模拟渠道响应格式错误')
    }
    return result
  }
  return {
    execute: (payment, signal) => request('/payments', signal, payment),
    query: (key, signal) => request(`/payments?key=${encodeURIComponent(key)}`, signal),
  }
}
