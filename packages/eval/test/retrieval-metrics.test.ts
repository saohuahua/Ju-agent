import { describe, expect, it } from 'vitest'
import { retrievalMetrics } from '../src/retrieval-metrics.js'

describe('检索指标分母', () => {
  it('多证据题命中一项不算完整召回且重复片段不多计', () => {
    expect(retrievalMetrics(['a', 'b'], ['x', 'a', 'a'], 3)).toMatchObject({
      recall: 0.5,
      reciprocalRank: 0.5,
      allEvidence: false,
    })
  })
  it('无答案题的召回分母为空而非自动记满分', () => {
    expect(retrievalMetrics([], [], 3)).toEqual({
      recall: null,
      reciprocalRank: null,
      allEvidence: null,
      emptyRetrieval: true,
    })
    expect(retrievalMetrics(['a'], ['x', 'a'], 1).reciprocalRank).toBe(0)
  })
})
