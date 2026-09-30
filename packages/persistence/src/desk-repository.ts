import { randomUUID } from 'node:crypto'
import type { AgentRunRecord, PolicyArticle } from '@aftersales/domain'
import type { SqliteDatabase } from './db.js'

export interface DeskPageOptions {
  limit: number
  query: string
  filter: 'all' | 'attention' | 'active'
  cursor?: { createdAt: string; runId: string }
}

type CaseRow = Omit<AgentRunRecord, 'faultPlan'> & {
  customerName: string | null
  title: string | null
  preview: string | null
}

/**
 * 工作台读模型集中处理页面需要的组合查询
 * 客户可见事件和内部备注使用不同的存储路径
 * 建表由统一迁移负责以保证服务启动和测试重置行为一致
 */
export class DeskRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * 创建时间与运行编号构成稳定游标 案件更新不会改变翻页位置
   * 一条查询同时返回案件与消息摘要 避免应用层逐案往返数据库
   * 搜索覆盖全库公开消息摘要且不匹配内部备注
   */
  cases(options: DeskPageOptions) {
    const conditions: string[] = []
    const params: Array<string | number> = []

    if (options.filter === 'attention') {
      conditions.push("r.status IN ('awaiting_approval', 'escalated', 'handling_human', 'failed')")
    } else if (options.filter === 'active') {
      conditions.push("r.status IN ('created', 'running', 'awaiting_input')")
    }

    if (options.cursor) {
      conditions.push('(r.created_at, r.run_id) < (?, ?)')
      params.push(options.cursor.createdAt, options.cursor.runId)
    }

    if (options.query) {
      conditions.push(`(
        instr(lower(COALESCE(c.name, '') || ' ' || r.customer_id || ' ' || r.run_id), lower(?)) > 0
        OR EXISTS (SELECT 1 FROM agent_events e WHERE e.run_id = r.run_id
          AND e.type IN ('message.user', 'message.completed', 'operator.message')
          AND instr(lower(COALESCE(json_extract(e.payload_json, '$.text'), '')), lower(?)) > 0)
      )`)
      params.push(options.query, options.query)
    }

    const rows = this.db
      .prepare(
        `
      SELECT r.run_id AS runId, r.customer_id AS customerId, r.status, r.intent,
        r.prompt_version AS promptVersion, r.model, r.error, r.source,
        r.created_at AS createdAt, r.updated_at AS updatedAt, c.name AS customerName,
        (SELECT json_extract(e.payload_json, '$.text') FROM agent_events e
          WHERE e.run_id = r.run_id AND e.type = 'message.user'
          ORDER BY e.sequence LIMIT 1) AS title,
        (SELECT json_extract(e.payload_json, '$.text') FROM agent_events e
          WHERE e.run_id = r.run_id AND e.type IN ('message.user', 'message.completed', 'operator.message')
          ORDER BY e.sequence DESC LIMIT 1) AS preview
      FROM agent_runs r LEFT JOIN customers c ON c.customer_id = r.customer_id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY r.created_at DESC, r.run_id DESC LIMIT ?
    `,
      )
      .all(...params, options.limit + 1) as CaseRow[]

    const cases = rows.slice(0, options.limit)
    const last = cases.at(-1)

    return {
      cases,
      next:
        rows.length > options.limit && last
          ? { createdAt: last.createdAt, runId: last.runId }
          : null,
    }
  }

  /**
   * 提取列表摘要时只读取客户消息与对外回复
   * 第一条客户消息作为标题 最近一条公开消息作为预览
   * 没有对应事件时保留空值交给页面显示真实空状态
   */
  summary(runId: string) {
    const row = this.db
      .prepare(
        `SELECT c.name AS customerName,
      (SELECT json_extract(e.payload_json, '$.text') FROM agent_events e
       WHERE e.run_id = r.run_id AND e.type = 'message.user' ORDER BY e.sequence LIMIT 1) AS title,
      (SELECT json_extract(e.payload_json, '$.text') FROM agent_events e
       WHERE e.run_id = r.run_id AND e.type IN ('message.user','message.completed','operator.message')
       ORDER BY e.sequence DESC LIMIT 1) AS preview
      FROM agent_runs r LEFT JOIN customers c ON c.customer_id = r.customer_id WHERE r.run_id = ?`,
      )
      .get(runId)
    return (row ?? {}) as { customerName?: string; title?: string; preview?: string }
  }

  context(runId: string, customerId: string) {
    // 只关联实际调用过的订单并再次检查客户归属
    // 被拒绝的越权工具参数不能成为工作台的订单依据
    const rows = this.db
      .prepare(
        `SELECT args_json FROM tool_executions
      WHERE run_id = ? AND tool_name = 'get_order' AND status = 'succeeded' ORDER BY id`,
      )
      .all(runId) as Array<{ args_json: string }>

    const orderNumbers = new Set<string>()

    for (const row of rows) {
      const args = JSON.parse(row.args_json) as Record<string, unknown>
      if (typeof args.orderNo === 'string') orderNumbers.add(args.orderNo)
    }

    const orders = [...orderNumbers].flatMap((orderNo) => {
      const row = this.db
        .prepare(
          `SELECT order_no AS orderNo, status, total_amount_cents AS totalAmountCents,
        items_json AS items, delivered_at AS deliveredAt FROM orders
        WHERE order_no = ? AND customer_id = ?`,
        )
        .get(orderNo, customerId) as
        | {
            orderNo: string
            status: string
            totalAmountCents: number
            items: string
            deliveredAt: string | null
          }
        | undefined
      return row ? [{ ...row, items: JSON.parse(row.items) as unknown[] }] : []
    })

    // 政策引用来自检索审计而不是模型生成的标题
    const policies = this.db
      .prepare(
        `SELECT DISTINCT p.article_id AS articleId, p.title, p.content,
      p.policy_version AS policyVersion, p.source FROM policy_articles p
      JOIN audit_logs a ON a.action = 'policy_articles_searched' AND a.run_id = ?
      JOIN json_each(a.detail_json, '$.articleIds') j ON j.value = p.article_id`,
      )
      .all(runId)

    const notes = this.db
      .prepare(
        `SELECT id, author, body, created_at AS createdAt
      FROM internal_notes WHERE run_id = ? ORDER BY created_at, id`,
      )
      .all(runId)

    return { orders, policies, notes }
  }

  /** 保存内部备注但不追加客户事件或模型上下文 */
  addNote(runId: string, author: string, body: string, createdAt: string) {
    const note = { id: randomUUID(), author, body, createdAt }

    this.db
      .prepare('INSERT INTO internal_notes VALUES (?, ?, ?, ?, ?)')
      .run(note.id, runId, author, body, createdAt)

    return note
  }

  /** 返回完整文档字段供知识列表与确定性检索共用 */
  policies(): PolicyArticle[] {
    return this.db
      .prepare(
        `SELECT article_id AS articleId, policy_version AS policyVersion,
      title, content, source, created_at AS createdAt FROM policy_articles ORDER BY article_id`,
      )
      .all() as PolicyArticle[]
  }
}
