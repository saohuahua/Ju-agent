import type { Hono } from 'hono'
import { DeskRepository } from '@aftersales/persistence'
import {
  buildKnowledgeSnapshot,
  retrieveKnowledge,
  POLICY_VERSION,
  redactText,
} from '@aftersales/domain'
import type { ComposedSystem } from '@aftersales/runtime'
import type { AppEnv } from './app.js'
import { requireRole } from './auth.js'

/**
 * 团队工作台的组合查询与内部协作入口
 * 整组路由在通用身份认证之后再检查团队角色
 * 查询试验使用零成本基线避免浏览页面触发付费模型调用
 */
export function registerDeskRoutes(app: Hono<AppEnv>, system: ComposedSystem) {
  const desk = new DeskRepository(system.db)

  // 团队查询入口不接受客户身份
  // 页面隐藏导航不能替代这里的服务端权限判断
  app.use('/api/desk/*', async (context, next) => {
    if (!requireRole(context, ['operator', 'supervisor'])) {
      return context.json({ error: 'AUTHORIZATION_DENIED', message: '仅售后团队可访问工作台' }, 403)
    }
    await next()
  })

  // 列表摘要不包含内部备注或服务端审批凭据
  app.get('/api/desk/cases', async (context) => {
    const limit = Number(context.req.query('limit') ?? 30)
    const query = context.req.query('q')?.trim() ?? ''
    const filter = context.req.query('filter') ?? 'all'
    const encoded = context.req.query('cursor')

    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      query.length > 200 ||
      !['all', 'attention', 'active'].includes(filter)
    ) {
      return context.json({ error: 'VALIDATION_ERROR', message: '分页或筛选参数不合法' }, 400)
    }

    let cursor: { createdAt: string; runId: string } | undefined

    if (encoded) {
      try {
        if (encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('cursor')
        const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))

        // 游标绑定筛选条件 防止更换搜索后复用旧页位置
        if (
          value.v !== 1 ||
          value.query !== query ||
          value.filter !== filter ||
          typeof value.createdAt !== 'string' ||
          !Number.isFinite(Date.parse(value.createdAt)) ||
          typeof value.runId !== 'string' ||
          !/^run_[a-zA-Z0-9_-]{1,100}$/.test(value.runId)
        ) {
          throw new Error('cursor')
        }

        cursor = { createdAt: value.createdAt, runId: value.runId }
      } catch {
        return context.json({ error: 'VALIDATION_ERROR', message: '分页游标无效 请刷新列表' }, 400)
      }
    }

    const page = desk.cases({
      limit,
      query,
      filter: filter as 'all' | 'attention' | 'active',
      cursor,
    })

    return context.json({
      cases: page.cases,
      nextCursor: page.next
        ? Buffer.from(JSON.stringify({ v: 1, ...page.next, query, filter })).toString('base64url')
        : null,
    })
  })

  // 先确认运行存在再读取与该运行关联的订单和证据
  app.get('/api/desk/cases/:runId', async (context) => {
    const run = await system.runService.get(context.req.param('runId'))
    return context.json({
      run,
      ...desk.summary(run.runId),
      ...desk.context(run.runId, run.customerId),
      closure: await system.handoverService.reviewClosure(context.get('actor'), run.runId),
    })
  })

  // 备注作者来自认证身份而不是客户端提交的字段
  app.post('/api/desk/cases/:runId/notes', async (context) => {
    const run = await system.runService.get(context.req.param('runId'))
    // 无效 JSON 作为输入错误返回而不是进入服务内部异常
    const input: unknown = await context.req.json().catch(() => null)
    const body = typeof input === 'object' && input !== null && 'body' in input ? input.body : null

    if (typeof body !== 'string' || !body.trim() || body.length > 2000) {
      return context.json({ error: 'VALIDATION_ERROR', message: '备注需要 1 至 2000 个字符' }, 400)
    }

    const note = desk.addNote(
      run.runId,
      context.get('actor').role,
      redactText(body.trim()),
      system.clock.now().toISOString(),
    )

    return context.json({ note }, 201)
  })

  // 当前知识试验只使用明确的政策版本 防止多版本入库后混合召回
  // 快照按内容构建 不冒充持久发布记录或具有已核验的有效期
  const knowledge = () =>
    buildKnowledgeSnapshot(
      desk.policies().filter((article) => article.policyVersion === POLICY_VERSION),
    )
  app.get('/api/desk/policies', (context) => {
    const snapshot = knowledge()
    return context.json({
      articles: snapshot.articles,
      snapshotId: snapshot.snapshotId,
      chunkVersion: snapshot.chunkVersion,
      chunks: snapshot.chunks,
      state: 'read_only_snapshot',
      effectiveAt: null,
      provenance: 'demo_policy_fixture',
    })
  })

  app.get('/api/desk/policies/search', async (context) => {
    const query = context.req.query('q')?.trim() ?? ''
    const strategy = context.req.query('strategy') ?? 'character-keyword-baseline'

    if (
      !query ||
      query.length > 500 ||
      !['character-keyword-baseline', 'bm25-bigram-v1'].includes(strategy)
    ) {
      return context.json(
        { error: 'VALIDATION_ERROR', message: '请输入 1 至 500 个字符的检索内容' },
        400,
      )
    }

    // 原文与命中片段分别返回 弹窗保持完整上下文而列表可展示具体检索位置
    const snapshot = knowledge()
    const ranked = retrieveKnowledge(
      snapshot,
      query,
      strategy as 'character-keyword-baseline' | 'bm25-bigram-v1',
    )
    const results = ranked.map((hit) => ({
      ...snapshot.articles.find((article) => article.articleId === hit.articleId)!,
      score: hit.score,
      chunk: hit,
      snapshotId: snapshot.snapshotId,
      reason: strategy === 'bm25-bigram-v1' ? '中文双字词项 BM25' : '原始字符关键词命中',
    }))

    return context.json({
      articles: results,
      count: results.length,
      strategy,
      snapshotId: snapshot.snapshotId,
      chunkVersion: snapshot.chunkVersion,
    })
  })
}
