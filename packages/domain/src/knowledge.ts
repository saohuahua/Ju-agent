import { createHash } from 'node:crypto'
import type { PolicyArticle } from './entities.js'

export const KNOWLEDGE_CONFIG = {
  chunkVersion: 'paragraph-window-v1',
  maxChunkChars: 320,
  k1: 1.2,
  b: 0.75,
} as const
export type RetrievalStrategy = 'character-keyword-baseline' | 'bm25-bigram-v1'

export interface KnowledgeChunk {
  chunkId: string
  articleId: string
  revision: string
  policyVersion: string
  source: string
  title: string
  content: string
  start: number
  end: number
  position: number
}

export interface KnowledgeSnapshot {
  snapshotId: string
  chunkVersion: string
  articles: Array<PolicyArticle & { revision: string }>
  chunks: KnowledgeChunk[]
}

/** 内容摘要参与引用身份 同一条款被修改后不会沿用旧片段标识 */
export function knowledgeHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * 构建当前只读语料快照 不写入数据库或冒充已发布索引
 * 段落优先保持完整 超长段落按窗口切开并保留原文偏移与父标题
 * 偏移采用 JavaScript UTF16 单位 可直接通过原文 slice 回查
 */
export function buildKnowledgeSnapshot(input: PolicyArticle[]): KnowledgeSnapshot {
  const ids = new Set<string>()
  const articles = [...input]
    .sort((a, b) => a.articleId.localeCompare(b.articleId))
    .map((article) => {
      if (ids.has(article.articleId) || !article.content.trim())
        throw new Error('政策标识重复或原文为空')
      ids.add(article.articleId)
      const revision = knowledgeHash([
        article.articleId,
        article.policyVersion,
        article.title,
        article.content,
        article.source,
      ])
      return { ...article, revision }
    })
  const chunks: KnowledgeChunk[] = []
  for (const article of articles) {
    let position = 0
    for (const paragraph of article.content.matchAll(/[^\r\n]+/g)) {
      const base = paragraph.index
      for (let offset = 0; offset < paragraph[0].length;) {
        const start = base + offset
        let end = Math.min(start + KNOWLEDGE_CONFIG.maxChunkChars, base + paragraph[0].length)
        // 不在代理对中间切开字符 避免片段展示出现损坏字符
        const last = article.content.charCodeAt(end - 1)
        if (last >= 0xd800 && last <= 0xdbff && end < article.content.length) end -= 1
        const content = article.content.slice(start, end)
        if (content.trim())
          chunks.push({
            chunkId: `${article.articleId}:${article.revision}:${position}`,
            articleId: article.articleId,
            revision: article.revision,
            policyVersion: article.policyVersion,
            source: article.source,
            title: article.title,
            content,
            start,
            end,
            position: position++,
          })
        offset = end - base
      }
    }
  }
  return {
    snapshotId: knowledgeHash({
      config: KNOWLEDGE_CONFIG,
      revisions: articles.map((article) => article.revision),
    }),
    chunkVersion: KNOWLEDGE_CONFIG.chunkVersion,
    articles,
    chunks,
  }
}

/** 中文连续字串采用双字词项 拉丁字母与编号保留整词 不注入题集专用同义词 */
export function knowledgeTerms(text: string): string[] {
  const terms: string[] = []
  for (const match of text
    .normalize('NFKC')
    .toLowerCase()
    .matchAll(/[\p{Script=Han}]+|[a-z0-9]+(?:[-_][a-z0-9]+)*/gu)) {
    const word = match[0]
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word]
      if (chars.length === 1) terms.push(word)
      for (let index = 0; index < chars.length - 1; index++)
        terms.push(chars[index]! + chars[index + 1]!)
    } else terms.push(word)
  }
  return terms
}

/**
 * 两个方案共享原文与快照 原始方案保持字符命中口径作为对照
 * BM25 以片段为检索单位 文档采用最高片段分数去重 防止长文靠片段数量占满前列
 * 分数仅表示词项相关程度 不作为资格判定或回答可信度
 */
export function retrieveKnowledge(
  snapshot: KnowledgeSnapshot,
  query: string,
  strategy: RetrievalStrategy,
  limit = 5,
) {
  if (!query.trim() || query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error('检索参数不合法')
  const terms = [...new Set(knowledgeTerms(query))]
  const documents = snapshot.chunks.map((chunk) =>
    knowledgeTerms(`${chunk.title} ${chunk.content}`),
  )
  const average =
    documents.reduce((sum, tokens) => sum + tokens.length, 0) / (documents.length || 1)
  const frequencies = new Map(
    terms.map((term) => [term, documents.filter((tokens) => tokens.includes(term)).length]),
  )
  const scored = snapshot.chunks
    .map((chunk, index) => {
      const tokens = documents[index]!
      let score = 0
      if (strategy === 'character-keyword-baseline') {
        const article = snapshot.articles.find((item) => item.articleId === chunk.articleId)!
        score = [...new Set(query)].filter((char) =>
          `${article.title}${article.content}`.includes(char),
        ).length
      } else {
        for (const term of terms) {
          const tf = tokens.filter((token) => token === term).length
          const df = frequencies.get(term) ?? 0
          if (!tf) continue
          const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))
          score +=
            (idf * tf * (KNOWLEDGE_CONFIG.k1 + 1)) /
            (tf +
              KNOWLEDGE_CONFIG.k1 *
                (1 - KNOWLEDGE_CONFIG.b + (KNOWLEDGE_CONFIG.b * tokens.length) / (average || 1)))
        }
      }
      return { ...chunk, score }
    })
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.articleId.localeCompare(b.articleId) || a.position - b.position,
    )
  const seen = new Set<string>()
  return scored
    .filter((item) => {
      if (seen.has(item.articleId)) return false
      seen.add(item.articleId)
      return true
    })
    .slice(0, limit)
}
