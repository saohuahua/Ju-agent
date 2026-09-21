/**
 * LLM 打分检索器
 *
 * 两级检索 先用确定性关键词打分召回候选 再把候选交给模型精排打分
 * 实测代理对过大的请求体静默返回空 单次调用约 20 秒 故预筛限定候选数
 * 走现有 Anthropic 兼容代理 不依赖 embedding 接口
 * 解析失败时返回全零分 检索如实降级为空 不编造
 */

import { KeywordPolicyScorer } from '@aftersales/domain'
import type { PolicyArticle, PolicyArticleScorer } from '@aftersales/domain'
import type { ChatModel, ContextBlock } from './model.js'

/** 打分调用输出上限 条款 JSON 约占数百 token */
const SCORING_MAX_TOKENS = 2000

/** 预筛候选数 关键词召回后交给 LLM 精排 保证请求体在代理可处理范围内 */
const PREFILTER_LIMIT = 8

const SCORING_SYSTEM = `你是售后政策检索打分器 根据客户问题对每条政策条款的相关性打分
返回 JSON 数组 每条包含 articleId score reason 三个字段
score 为 0 到 10 的整数 0 表示完全无关 只对相关的条款给正分
reason 一句话说明判断依据 只输出 JSON 不要输出其他内容`

export class ChatModelPolicyScorer implements PolicyArticleScorer {
  /** 关键词预筛 与评测同算法 保证召回层行为一致 */
  private readonly prefilter = new KeywordPolicyScorer()

  constructor(private readonly model: ChatModel) {}

  async score(
    query: string,
    articles: PolicyArticle[],
  ): Promise<Array<{ articleId: string; score: number; reason: string }>> {
    if (articles.length === 0) return []
    const byId = new Map(articles.map((article) => [article.articleId, article]))
    const recalled = (await this.prefilter.score(query, articles))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.articleId.localeCompare(b.articleId))
      .slice(0, PREFILTER_LIMIT)
    const candidates = recalled.flatMap((item) => {
      const article = byId.get(item.articleId)
      return article
        ? [{ articleId: article.articleId, title: article.title, content: article.content }]
        : []
    })
    if (candidates.length === 0) return []
    const content: ContextBlock[] = [
      {
        type: 'text',
        text: `客户问题 ${query}\n候选政策条款\n${JSON.stringify(candidates)}`,
      },
    ]
    let text = ''
    try {
      for await (const event of this.model.stream({
        system: SCORING_SYSTEM,
        messages: [{ role: 'user', content }],
        tools: [],
        maxTokens: SCORING_MAX_TOKENS,
      })) {
        if (event.type === 'text_delta') text += event.text
      }
      return parseScores(text)
    } catch {
      return []
    }
  }
}

/** 解析模型输出 容忍代码围栏与前后缀 解析失败返回空 */
function parseScores(
  raw: string,
): Array<{ articleId: string; score: number; reason: string }> {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const entry = item as Record<string, unknown>
      if (typeof entry.articleId !== 'string' || typeof entry.reason !== 'string') return []
      const score = Number(entry.score)
      if (!Number.isFinite(score) || score < 0) return []
      return [{ articleId: entry.articleId, score, reason: entry.reason }]
    })
  } catch {
    return []
  }
}
