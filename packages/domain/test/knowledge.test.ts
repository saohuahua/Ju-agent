import { describe, expect, it } from 'vitest'
import { buildKnowledgeSnapshot, retrieveKnowledge } from '../src/knowledge.js'

const article = {
  articleId: 'quality',
  policyVersion: 'v1',
  title: '质量政策',
  content: '质量问题可以退货',
  source: 'fixture',
  createdAt: '2026-09-20',
}

describe('知识快照与确定性检索', () => {
  it('片段可逐字回查且长文本切分不丢字符', () => {
    const content = '质量'.repeat(159) + '😀' + '退货'.repeat(170)
    const snapshot = buildKnowledgeSnapshot([{ ...article, content }])
    expect(snapshot.chunks.map((chunk) => chunk.content).join('')).toBe(content)
    for (const chunk of snapshot.chunks)
      expect(content.slice(chunk.start, chunk.end)).toBe(chunk.content)
  })

  it('内容修改产生新版本且输入顺序不影响快照', () => {
    const other = { ...article, articleId: 'other' }
    const first = buildKnowledgeSnapshot([article, other])
    expect(buildKnowledgeSnapshot([other, article]).snapshotId).toBe(first.snapshotId)
    expect(buildKnowledgeSnapshot([{ ...article, content: '新条款' }, other]).snapshotId).not.toBe(
      first.snapshotId,
    )
    expect(() => buildKnowledgeSnapshot([article, article])).toThrow()
  })

  it('无词项命中返回空而多片段文档只占一个结果', () => {
    const snapshot = buildKnowledgeSnapshot([
      { ...article, content: '质量问题\n质量问题\n质量问题' },
    ])
    expect(retrieveKnowledge(snapshot, '火星矿物', 'bm25-bigram-v1')).toEqual([])
    expect(retrieveKnowledge(snapshot, '质量', 'bm25-bigram-v1')).toHaveLength(1)
    expect(() => retrieveKnowledge(snapshot, ' ', 'bm25-bigram-v1')).toThrow()
  })
})
