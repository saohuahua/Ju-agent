'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileText } from 'lucide-react'
import { DeskEmpty } from '@/components/desk/DeskEmpty'
import { PolicyDialog } from '@/components/desk/PolicyDialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { RefreshButton } from '@/components/ui/refresh-button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { deskApi, type PolicyDocument } from '@/lib/desk-api'
import { useIdentity } from '@/lib/identity'

/** 知识页面仅展示已入库政策 搜索明确使用零成本关键词基线 */
export default function PoliciesPage() {
  const { role } = useIdentity()

  return (
    <>
      {role === 'customer' ? (
        <DeskEmpty title="政策管理仅供团队使用" description="客户可在售后会话中咨询适用条款" />
      ) : (
        <PolicyLibrary />
      )}
    </>
  )
}

function PolicyLibrary() {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [strategy, setStrategy] = useState('character-keyword-baseline')
  const [document, setDocument] = useState<PolicyDocument | null>(null)
  // 语料元信息独立查询 搜索空结果时仍能核对所用快照
  const library = useQuery({
    queryKey: ['knowledge-library'],
    queryFn: ({ signal }) => deskApi.policies(signal),
  })
  const result = useQuery({
    queryKey: ['policies', query, strategy],
    queryFn: ({ signal }) => deskApi.search(query, strategy, signal),
    enabled: Boolean(query),
  })
  const active = query ? result : library

  return (
    <div className="youju-page">
      <header className="youju-page-heading">
        <div>
          <p className="youju-eyebrow">可追溯的处理依据</p>
          <h1>知识与政策</h1>
          <p>政策快照的原文 分块与确定性检索 不调用模型或 Embedding</p>
        </div>
      </header>
      {library.data && (
        <Alert className="mb-5">
          <AlertDescription>
            <p>
              只读快照 · {library.data.articles.length} 篇原文 · {library.data.chunks.length} 个片段
            </p>
            <p className="break-all">快照 {library.data.snapshotId}</p>
            <p>分块 {library.data.chunkVersion} · 有效期未提供 · 尚未发布持久索引</p>
          </AlertDescription>
        </Alert>
      )}
      <Tabs value={strategy} onValueChange={setStrategy} className="mb-5">
        <TabsList aria-label="关键词检索方案">
          <TabsTrigger value="character-keyword-baseline">原始字符基线</TabsTrigger>
          <TabsTrigger value="bm25-bigram-v1">BM25 双字基线</TabsTrigger>
        </TabsList>
      </Tabs>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          setQuery(draft.trim())
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="policy-search">检索政策</FieldLabel>
            <Input
              id="policy-search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={500}
              placeholder="例如 退款 物流延迟 价格保护"
            />
          </Field>
        </FieldGroup>
        <Button type="submit">检索</Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setDraft('')
            setQuery('')
          }}
        >
          全部
        </Button>
      </form>
      {active.isPending && (
        <div role="status" aria-label="正在读取政策">
          <Skeleton className="mt-6 h-36" />
        </div>
      )}
      {active.error && (
        <Alert variant="destructive" className="mt-6">
          <AlertDescription>
            {active.error.message}
            <RefreshButton
              variant="link"
              disabled={active.isFetching}
              onRefresh={() => active.refetch()}
            >
              重试
            </RefreshButton>
          </AlertDescription>
        </Alert>
      )}
      {active.data?.articles.length === 0 && (
        <DeskEmpty
          title="没有匹配的政策"
          description="调整问题关键词 当前结果不能作为支持处理方案的依据"
        />
      )}
      <div className="youju-document-grid">
        {!active.isError &&
          active.data?.articles.map((article) => (
            <button
              key={article.articleId}
              className="youju-evidence-card youju-policy-button"
              onClick={() => setDocument(article)}
            >
              <FileText aria-hidden="true" />
              <strong>{article.title}</strong>
              <p className="line-clamp-3">{article.chunk?.content ?? article.content}</p>
              <span>
                版本 {article.policyVersion} · {article.source}
              </span>
              {article.score !== undefined && (
                <span>
                  {article.reason} · 分数 {article.score.toFixed(3)}
                </span>
              )}
              {article.chunk && (
                <span>
                  片段 {article.chunk.position + 1} · 原文位置 {article.chunk.start} 至{' '}
                  {article.chunk.end}
                </span>
              )}
            </button>
          ))}
      </div>
      <p className="youju-source">
        检索分数不代表答案正确率或政策适用结论 无匹配时应继续澄清或转人工
      </p>
      <PolicyDialog document={document} onClose={() => setDocument(null)} />
    </div>
  )
}
