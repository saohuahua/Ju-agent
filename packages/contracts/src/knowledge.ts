import { z } from 'zod'

/** 片段身份与原文偏移成对传输 用于核验引用而非表达政策适用性 */
export const KnowledgeChunkView = z.object({
  chunkId: z.string(),
  articleId: z.string(),
  revision: z.string(),
  policyVersion: z.string(),
  source: z.string(),
  title: z.string(),
  content: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  position: z.number().int().nonnegative(),
})
export const KnowledgeArticleView = z.object({
  articleId: z.string(),
  policyVersion: z.string(),
  title: z.string(),
  content: z.string(),
  source: z.string(),
  revision: z.string(),
  score: z.number().optional(),
  chunk: KnowledgeChunkView.optional(),
  snapshotId: z.string().optional(),
  reason: z.string().optional(),
})
export const KnowledgeLibraryResponse = z.object({
  articles: z.array(KnowledgeArticleView),
  snapshotId: z.string(),
  chunkVersion: z.string(),
  chunks: z.array(KnowledgeChunkView),
  state: z.literal('read_only_snapshot'),
  effectiveAt: z.null(),
  provenance: z.literal('demo_policy_fixture'),
})
export const KnowledgeSearchResponse = z.object({
  articles: z.array(
    KnowledgeArticleView.extend({
      chunk: KnowledgeChunkView,
      score: z.number(),
      snapshotId: z.string(),
    }),
  ),
  count: z.number().int().nonnegative(),
  strategy: z.enum(['character-keyword-baseline', 'bm25-bigram-v1']),
  snapshotId: z.string(),
  chunkVersion: z.string(),
})
