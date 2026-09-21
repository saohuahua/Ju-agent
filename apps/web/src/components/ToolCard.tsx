'use client'

/**
 * 工具执行卡片
 *
 * 展示单次工具调用的名称 尝试次数 结果摘要与错误码
 * 展示层不做业务判断 只忠实呈现轨迹证据
 * 视觉：hairline 白卡 + 左侧按执行状态着色的 2px 竖条
 */

import type { ToolItem } from '@/lib/runReducer'

const STATUS_BAR = {
  pending: 'bg-stone-300',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
} as const

const STATUS_LABEL = {
  pending: '执行中',
  succeeded: '成功',
  failed: '失败',
} as const

const STATUS_TEXT = {
  pending: 'text-stone-500',
  succeeded: 'text-emerald-700',
  failed: 'text-red-700',
} as const

export function ToolCard({ tool }: { tool: ToolItem }) {
  const summaryEntries = Object.entries(tool.resultSummary ?? {}).slice(0, 4)
  const policyArticles =
    tool.toolName === 'search_policy'
      ? ((tool.resultSummary?.articles as PolicyArticleSummary[] | undefined) ?? [])
      : []
  return (
    <div className="relative rounded-container border border-hairline bg-white px-3 py-2 text-xs">
      <span
        aria-hidden="true"
        className={`absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full ${STATUS_BAR[tool.status]}`}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[13px] text-stone-800">{tool.toolName}</span>
        <span className="flex items-center gap-2 text-stone-500">
          {tool.inputStreaming && (
            <span className="text-teal-700" aria-live="polite">
              参数生成中
            </span>
          )}
          {tool.attempt > 1 && <span>第 {tool.attempt} 次尝试</span>}
          {tool.latencyMs !== undefined && (
            <span className="tabular-nums">{tool.latencyMs}ms</span>
          )}
          <span className={STATUS_TEXT[tool.status]}>{STATUS_LABEL[tool.status]}</span>
        </span>
      </div>
      {tool.inputJson && (
        <div className="mt-1.5 truncate font-mono text-stone-400" aria-label="工具参数">
          {tool.inputJson}
        </div>
      )}
      {policyArticles.length > 0 && (
        <ul className="mt-1.5 space-y-1.5">
          {policyArticles.map((article) => (
            <li key={article.articleId} className="rounded-md bg-stone-50 px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-stone-800">{article.title}</span>
                <span className="shrink-0 font-mono text-stone-400">
                  {article.articleId} · {article.score} 分
                </span>
              </div>
              <p className="mt-0.5 leading-relaxed text-stone-600">{article.content}</p>
            </li>
          ))}
        </ul>
      )}
      {tool.errorCode && <div className="mt-1 font-mono text-red-700">{tool.errorCode}</div>}
      {summaryEntries.length > 0 && policyArticles.length === 0 && (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-stone-500">
          {summaryEntries.map(([key, value]) => (
            <div key={key} className="col-span-2 flex gap-3 truncate">
              <dt className="shrink-0 font-mono">{key}</dt>
              <dd className="truncate text-stone-700">{formatValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

interface PolicyArticleSummary {
  articleId: string
  title: string
  content: string
  score: number
  reason: string
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
