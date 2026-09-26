import { request } from './api'
import type { RunSummary } from './types'

export interface DeskCase extends RunSummary {
  customerName?: string | null
  title?: string | null
  preview?: string | null
}

export interface DeskPage {
  cases: DeskCase[]
  nextCursor: string | null
}

export interface PolicyDocument {
  articleId: string
  title: string
  content: string
  policyVersion: string
  source: string
  score?: number
  reason?: string
  revision?: string
  snapshotId?: string
  chunk?: KnowledgeChunk
}

export interface KnowledgeChunk {
  chunkId: string
  articleId: string
  revision: string
  position: number
  start: number
  end: number
  content: string
}

export interface KnowledgeLibrary {
  articles: PolicyDocument[]
  snapshotId: string
  chunkVersion: string
  chunks: KnowledgeChunk[]
  state: 'read_only_snapshot'
  effectiveAt: null
  provenance: 'demo_policy_fixture'
}

export interface DeskDetail {
  run: RunSummary
  customerName?: string
  title?: string
  orders: Array<{
    orderNo: string
    status: string
    totalAmountCents: number
    deliveredAt: string | null
    items: Array<{ title?: string; sku?: string; quantity?: number }>
  }>
  policies: PolicyDocument[]
  notes: Array<{ id: string; author: string; body: string; createdAt: string }>
  closure: {
    canResolve: boolean
    blockers: Array<{ resourceType: string; resourceId: string; status: string; reason: string }>
  }
}

export const deskApi = {
  // 查询取消信号贯穿到网络层防止已离开的页面继续占用请求
  cases: (
    options: { query: string; filter: string; cursor?: string | null },
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams({ q: options.query, filter: options.filter, limit: '30' })
    if (options.cursor) params.set('cursor', options.cursor)

    return request<DeskPage>(`/api/desk/cases?${params}`, { signal })
  },
  detail: (id: string, signal?: AbortSignal) =>
    request<DeskDetail>(`/api/desk/cases/${encodeURIComponent(id)}`, { signal }),
  note: (id: string, body: string) =>
    request(`/api/desk/cases/${encodeURIComponent(id)}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
  policies: (signal?: AbortSignal) => request<KnowledgeLibrary>('/api/desk/policies', { signal }),
  search: (query: string, strategy = 'character-keyword-baseline', signal?: AbortSignal) =>
    request<{ articles: PolicyDocument[]; count: number; snapshotId: string; strategy: string }>(
      `/api/desk/policies/search?q=${encodeURIComponent(query)}&strategy=${encodeURIComponent(strategy)}`,
      { signal },
    ),
}
