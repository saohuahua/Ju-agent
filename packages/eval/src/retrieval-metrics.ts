/**
 * 文档级指标先去重 防止同一文档的多个片段重复算命中
 * 无答案题不进入召回与倒数排名分母 单独记录空召回率
 */
export function retrievalMetrics(relevantIds: string[], rankedIds: string[], k: number) {
  if (!Number.isInteger(k) || k < 1) throw new Error('指标截断位置必须为正整数')
  const relevant = new Set(relevantIds)
  const ranked = [...new Set(rankedIds)].slice(0, k)
  const hits = ranked.filter((id) => relevant.has(id)).length
  const first = ranked.findIndex((id) => relevant.has(id))
  return {
    recall: relevant.size ? hits / relevant.size : null,
    reciprocalRank: relevant.size ? (first < 0 ? 0 : 1 / (first + 1)) : null,
    allEvidence: relevant.size ? hits === relevant.size : null,
    emptyRetrieval: ranked.length === 0,
  }
}
