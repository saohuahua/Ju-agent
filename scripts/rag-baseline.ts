import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { BASELINE_FIXTURE } from '@aftersales/persistence'
import {
  buildKnowledgeSnapshot,
  retrieveKnowledge,
  knowledgeHash,
  KNOWLEDGE_CONFIG,
  POLICY_VERSION,
  type RetrievalStrategy,
} from '@aftersales/domain'
import { retrievalMetrics } from '../packages/eval/src/retrieval-metrics.js'

/**
 * 离线评测只读冻结题集与演示语料 不实例化运行器或任何付费适配器
 * tuning 与 holdout 分开报告 排除项保留诊断轨迹但不混入主指标
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataset = JSON.parse(readFileSync(resolve(root, 'eval/rag/dataset-v1.1.json'), 'utf8')) as {
  datasetVersion: string
  corpusSha256: string
  policyVersion: string
  cases: Array<{
    id: string
    split: 'tuning' | 'holdout'
    question: string
    relevantArticleIds: string[]
    answerability: string
  }>
}
const protocol = JSON.parse(readFileSync(resolve(root, 'eval/rag/protocol-v1.json'), 'utf8')) as {
  version: string
  datasetVersion: string
  maxChunkChars: number
  chunkVersion: string
  bm25: { k1: number; b: number }
  strategies: RetrievalStrategy[]
  cutoffs: number[]
  excludedCaseIds: string[]
}
const corpus = BASELINE_FIXTURE.policyArticles.map((article) => ({
  articleId: article.article_id,
  title: article.title,
  content: article.content,
  source: article.source,
}))
const corpusSha256 = knowledgeHash({ policyVersion: POLICY_VERSION, articles: corpus })
if (
  dataset.corpusSha256 !== corpusSha256 ||
  dataset.policyVersion !== POLICY_VERSION ||
  dataset.datasetVersion !== protocol.datasetVersion
)
  throw new Error('冻结题集与语料不一致 请先复核版本')
if (
  protocol.maxChunkChars !== KNOWLEDGE_CONFIG.maxChunkChars ||
  protocol.chunkVersion !== KNOWLEDGE_CONFIG.chunkVersion ||
  protocol.bm25.k1 !== KNOWLEDGE_CONFIG.k1 ||
  protocol.bm25.b !== KNOWLEDGE_CONFIG.b
)
  throw new Error('检索实现与冻结参数不一致')

const snapshot = buildKnowledgeSnapshot(
  corpus.map((article) => ({
    ...article,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-09-20T12:00:00.000Z',
  })),
)
const traces = []
for (const strategy of protocol.strategies) {
  for (const item of dataset.cases) {
    const started = performance.now()
    const retrieved = retrieveKnowledge(
      snapshot,
      item.question,
      strategy,
      Math.max(...protocol.cutoffs),
    )
    // 引用有效性仅核验片段存在和原文一致 不冒充引用支持答案的语义评分
    const validCitations = retrieved.filter((hit) => {
      const source = snapshot.articles.find((article) => article.articleId === hit.articleId)
      return (
        source?.revision === hit.revision &&
        source.content.slice(hit.start, hit.end) === hit.content &&
        snapshot.chunks.some((chunk) => chunk.chunkId === hit.chunkId)
      )
    }).length
    traces.push({
      caseId: item.id,
      split: item.split,
      strategy,
      answerability: item.answerability,
      excluded: protocol.excludedCaseIds.includes(item.id),
      elapsedMs: performance.now() - started,
      validCitations,
      citationCount: retrieved.length,
      retrieved: retrieved.map((hit) => ({
        articleId: hit.articleId,
        chunkId: hit.chunkId,
        revision: hit.revision,
        score: hit.score,
      })),
      metrics: protocol.cutoffs.map((k) => ({
        k,
        ...retrievalMetrics(
          item.relevantArticleIds,
          retrieved.map((hit) => hit.articleId),
          k,
        ),
      })),
    })
  }
}

const aggregates = protocol.strategies.flatMap((strategy) =>
  ['tuning', 'holdout'].flatMap((split) =>
    protocol.cutoffs.map((k) => {
      const selected = traces.filter(
        (row) => row.strategy === strategy && row.split === split && !row.excluded,
      )
      const metrics = selected.map((row) => row.metrics.find((metric) => metric.k === k)!)
      const answerable = metrics.filter((metric) => metric.recall !== null)
      const unsupported = metrics.filter((metric) => metric.recall === null)
      return {
        strategy,
        split,
        k,
        total: selected.length,
        relevantDenominator: answerable.length,
        unsupportedDenominator: unsupported.length,
        recall: answerable.length
          ? answerable.reduce((sum, metric) => sum + metric.recall!, 0) / answerable.length
          : null,
        mrr: answerable.length
          ? answerable.reduce((sum, metric) => sum + metric.reciprocalRank!, 0) / answerable.length
          : null,
        allEvidenceRate: answerable.length
          ? answerable.filter((metric) => metric.allEvidence).length / answerable.length
          : null,
        emptyRetrievalRate: unsupported.length
          ? unsupported.filter((metric) => metric.emptyRetrieval).length / unsupported.length
          : null,
      }
    }),
  ),
)

// 未提交代码用源文件摘要补足追溯 不能仅以 HEAD 冒充本轮实现版本
const sourcePaths = [
  'packages/domain/src/knowledge.ts',
  'packages/eval/src/retrieval-metrics.ts',
  'scripts/rag-baseline.ts',
  'eval/rag/dataset-v1.1.json',
  'eval/rag/protocol-v1.json',
]
const sourceHashes = Object.fromEntries(
  sourcePaths.map((path) => [path, knowledgeHash(readFileSync(resolve(root, path), 'utf8'))]),
)
const codeHead = execFileSync(
  'git',
  ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'rev-parse', 'HEAD'],
  { cwd: root, encoding: 'utf8' },
).trim()
const report = {
  generatedAt: new Date().toISOString(),
  protocolVersion: protocol.version,
  datasetVersion: dataset.datasetVersion,
  corpusSha256,
  snapshotId: snapshot.snapshotId,
  codeHead,
  sourceHashes,
  config: KNOWLEDGE_CONFIG,
  model: null,
  promptVersion: null,
  costCents: 0,
  modelCalls: 0,
  repeats: 1,
  note: '确定性检索模块评测 不代表答案正确率 引用支持率或真实模型能力 两个待复核题不计入主指标',
  aggregates,
  traces,
}
const output = resolve(root, 'eval/rag/results', new Date().toISOString().replaceAll(/[:.]/g, '-'))
mkdirSync(output, { recursive: true })
writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
writeFileSync(resolve(output, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n')
console.log(JSON.stringify({ output, aggregates }, null, 2))
