/**
 * 政策检索服务
 *
 * 检索只辅助 Agent 解释政策 终判永远留在确定性政策引擎
 * 打分器是外部端口 生产接 LLM 打分 测试与评测接确定性关键词打分
 * 检索不到相关条款时如实返回空 由 Agent 说明需人工确认 不编造
 */

import { POLICY_VERSION } from '../policy.js'
import type { Actor, PolicyArticle } from '../entities.js'
import type { PolicyArticleRepository } from '../repositories.js'
import type { AuditService } from './audit-service.js'

/** 检索打分端口 对全部语料条款打分 返回各条款分数与理由 */
export interface PolicyArticleScorer {
  score(
    query: string,
    articles: PolicyArticle[],
  ): Promise<Array<{ articleId: string; score: number; reason: string }>>
}

export interface ScoredPolicyArticle {
  articleId: string
  title: string
  content: string
  score: number
  reason: string
}

/**
 * 确定性关键词打分器
 *
 * 按查询与条款标题正文的字符命中数计分 中文无分词仍稳定
 * 评测与离线测试用 保证检索结果同构可复现
 */
export class KeywordPolicyScorer implements PolicyArticleScorer {
  async score(
    query: string,
    articles: PolicyArticle[],
  ): Promise<Array<{ articleId: string; score: number; reason: string }>> {
    const queryChars = new Set([...query])
    return articles.map((article) => {
      const haystack = `${article.title}${article.content}`
      const hits = [...queryChars].filter((char) => haystack.includes(char)).length
      return {
        articleId: article.articleId,
        score: hits,
        reason: `关键词命中 ${hits} 处`,
      }
    })
  }
}

/** 检索默认返回条数 */
export const POLICY_SEARCH_DEFAULT_LIMIT = 3

export class PolicySearchService {
  constructor(
    private readonly articleRepo: PolicyArticleRepository,
    private readonly scorer: PolicyArticleScorer,
    private readonly auditService: AuditService,
  ) {}

  /**
   * 按客户问题检索相关政策条款
   *
   * 全量语料打分后取分数最高且大于零的前 limit 条
   * 零命中返回空 调用方不得据此编造政策
   */
  async search(
    actor: Actor,
    query: string,
    limit = POLICY_SEARCH_DEFAULT_LIMIT,
    runId?: string,
  ): Promise<{ articles: ScoredPolicyArticle[]; count: number }> {
    const articles = await this.articleRepo.listByVersion(POLICY_VERSION)
    const scores = await this.scorer.score(query, articles)
    const ranked = scores
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.articleId.localeCompare(b.articleId))
      .slice(0, limit)
    const byId = new Map(articles.map((article) => [article.articleId, article]))
    const result = ranked.flatMap((item) => {
      const article = byId.get(item.articleId)
      return article
        ? [
            {
              articleId: article.articleId,
              title: article.title,
              content: article.content,
              score: item.score,
              reason: item.reason,
            },
          ]
        : []
    })
    await this.auditService.record(
      actor,
      'policy_articles_searched',
      'policy',
      query,
      {
        articleIds: result.map((article) => article.articleId),
      },
      runId,
    )
    return { articles: result, count: result.length }
  }
}
