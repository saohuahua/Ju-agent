/**
 * 政策检索服务测试
 *
 * 检索只辅助解释 终判留在确定性引擎
 * 覆盖 打分排序 条数限制 零命中如实返回 审计留痕 打分器端口可替换
 */

import { describe, expect, it } from 'vitest'
import { AuditService, FrozenClock, KeywordPolicyScorer, PolicySearchService } from '../src/index.js'
import type { PolicyArticle, PolicyArticleScorer } from '../src/index.js'
import { testing } from '../src/index.js'

const BASE_TIME = '2026-09-20T12:00:00.000Z'

function makeArticle(overrides: Partial<PolicyArticle> = {}): PolicyArticle {
  return {
    articleId: 'A1',
    policyVersion: '2026.09-v3',
    title: '条款一',
    content: '条款正文',
    source: 'rules',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

function setup() {
  const repos = testing.createInMemoryRepositories()
  const clock = new FrozenClock(BASE_TIME)
  const auditService = new AuditService(repos.auditRepo, clock)
  const service = new PolicySearchService(repos.policyArticleRepo, new KeywordPolicyScorer(), auditService)
  return { repos, service, clock }
}

/** 可控打分器 分数直接由测试给定 */
function fixedScorer(scores: Record<string, number>): PolicyArticleScorer {
  return {
    async score(_query, articles) {
      return articles.map((article) => ({
        articleId: article.articleId,
        score: scores[article.articleId] ?? 0,
        reason: '固定分数',
      }))
    },
  }
}

describe('PolicySearchService', () => {
  it('按分数降序取前 limit 条并过滤零分', async () => {
    const { repos } = setup()
    repos.policyArticleRepo.articles.set(
      'A1',
      makeArticle({ articleId: 'A1', title: '七天无理由', content: '七天无理由退货' }),
    )
    repos.policyArticleRepo.articles.set(
      'A2',
      makeArticle({ articleId: 'A2', title: '质量问题', content: '质量问题十五天内可退' }),
    )
    repos.policyArticleRepo.articles.set(
      'A3',
      makeArticle({ articleId: 'A3', title: '无关条款', content: '大件安装规则' }),
    )
    const scorer = fixedScorer({ A1: 3, A2: 8, A3: 0 })
    const auditService = new AuditService(repos.auditRepo, new FrozenClock(BASE_TIME))
    const target = new PolicySearchService(repos.policyArticleRepo, scorer, auditService)

    const result = await target.search({ role: 'customer', customerId: 'C1001' }, '查询', 2)
    expect(result.articles.map((a) => a.articleId)).toEqual(['A2', 'A1'])
    expect(result.count).toBe(2)
  })

  it('关键词打分器命中越多分数越高 与正文内容匹配', async () => {
    const { repos, service } = setup()
    repos.policyArticleRepo.articles.set(
      'A1',
      makeArticle({ articleId: 'A1', title: '生鲜食品', content: '生鲜食品不支持七天无理由退货' }),
    )
    repos.policyArticleRepo.articles.set(
      'A2',
      makeArticle({ articleId: 'A2', title: '大件安装', content: '大件商品安装后不支持退货' }),
    )
    const result = await service.search({ role: 'customer' }, '生鲜能无理由退货吗', 3)
    expect(result.articles[0]!.articleId).toBe('A1')
    expect(result.articles[0]!.score).toBeGreaterThan(0)
    expect(result.articles[0]!.reason).toContain('关键词命中')
  })

  it('零命中时如实返回空 不编造条款', async () => {
    const { repos, service } = setup()
    repos.policyArticleRepo.articles.set(
      'A1',
      makeArticle({ articleId: 'A1', title: '七天无理由', content: '七天无理由退货' }),
    )
    const result = await service.search({ role: 'customer' }, '优惠券过期能补发吗', 3)
    expect(result.articles).toEqual([])
    expect(result.count).toBe(0)
  })

  it('每次检索写入审计 记录命中条款编号', async () => {
    const { repos, service } = setup()
    repos.policyArticleRepo.articles.set(
      'A1',
      makeArticle({ articleId: 'A1', title: '质量问题', content: '质量问题自签收起十五天内可退换' }),
    )
    await service.search({ role: 'customer', customerId: 'C1001' }, '质量问题多久可以退', 3, 'run_1')
    const entries = repos.auditRepo.entries.filter((e) => e.action === 'policy_articles_searched')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.resourceType).toBe('policy')
    expect(entries[0]!.resourceId).toBe('质量问题多久可以退')
    expect(entries[0]!.detail).toEqual({ articleIds: ['A1'] })
    expect(entries[0]!.runId).toBe('run_1')
  })

  it('语料为空时返回空且审计留痕', async () => {
    const { repos, service } = setup()
    const result = await service.search({ role: 'customer' }, '任何问题', 3)
    expect(result.count).toBe(0)
    expect(repos.auditRepo.entries.filter((e) => e.action === 'policy_articles_searched')).toHaveLength(1)
  })
})
