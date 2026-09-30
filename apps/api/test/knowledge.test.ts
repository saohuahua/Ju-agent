import { afterEach, describe, expect, it } from 'vitest'
import { ScriptedModel } from '@aftersales/agent'
import { KnowledgeLibraryResponse, KnowledgeSearchResponse } from '@aftersales/contracts'
import { FrozenClock } from '@aftersales/domain'
import { composeSystem, type ComposedSystem } from '@aftersales/runtime'
import { createApp } from '../src/app.js'

const systems: ComposedSystem[] = []
const headers = { Authorization: 'Bearer operator-token' }
afterEach(() => {
  for (const system of systems.splice(0)) system.db.close()
})

/** 直接调用正式路由 校验快照与搜索结果处于同一原文版本 */
function fixture() {
  const system = composeSystem({
    clock: new FrozenClock('2026-09-20T12:00:00Z'),
    model: new ScriptedModel([]),
  })
  systems.push(system)
  return { system, app: createApp({ system, modelAvailable: false }) }
}

describe('知识快照接口', () => {
  it('分块引用可以在同一快照中查回且不混入其他政策版本', async () => {
    const { system, app } = fixture()
    system.db
      .prepare(
        "INSERT INTO policy_articles VALUES ('old-only', 'old', '旧政策', '质量问题退货', 'fixture', '2020-01-01')",
      )
      .run()
    const library = KnowledgeLibraryResponse.parse(
      await (await app.request('/api/desk/policies', { headers })).json(),
    )
    expect(library.articles).toHaveLength(19)
    expect(library.effectiveAt).toBeNull()
    expect(library.state).toBe('read_only_snapshot')
    const response = await app.request(
      `/api/desk/policies/search?q=${encodeURIComponent('质量问题退货')}&strategy=bm25-bigram-v1`,
      { headers },
    )
    expect(response.status).toBe(200)
    const search = KnowledgeSearchResponse.parse(await response.json())
    expect(search.snapshotId).toBe(library.snapshotId)
    expect(search.count).toBeGreaterThan(0)
    for (const item of search.articles) {
      expect(item.content.slice(item.chunk.start, item.chunk.end)).toBe(item.chunk.content)
      expect(
        library.chunks.some((chunk: { chunkId: string }) => chunk.chunkId === item.chunk.chunkId),
      ).toBe(true)
      expect(item.revision).toBe(item.chunk.revision)
    }
  })

  it('空库不伪造引用且未知策略和客户访问均被拒绝', async () => {
    const { system, app } = fixture()
    system.db.prepare('DELETE FROM policy_articles').run()
    const response = await app.request('/api/desk/policies/search?q=test&strategy=bm25-bigram-v1', {
      headers,
    })
    expect(await response.json()).toMatchObject({ articles: [], count: 0 })
    expect(
      (await app.request('/api/desk/policies/search?q=test&strategy=vector', { headers })).status,
    ).toBe(400)
    expect(
      (
        await app.request('/api/desk/policies', {
          headers: { Authorization: 'Bearer cust-token-1001' },
        })
      ).status,
    ).toBe(403)
  })
})
