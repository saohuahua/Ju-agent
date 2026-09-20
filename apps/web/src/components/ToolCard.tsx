'use client'

/**
 * 工具执行卡片
 *
 * 展示单次工具调用的名称 尝试次数 结果摘要与错误码
 * 展示层不做业务判断 只忠实呈现轨迹证据
 */

import type { ToolItem } from '@/lib/runReducer'

const STATUS_STYLE = {
  pending: 'border-slate-700 bg-slate-800/60',
  succeeded: 'border-emerald-800 bg-emerald-950/40',
  failed: 'border-red-800 bg-red-950/40',
} as const

const STATUS_LABEL = {
  pending: '执行中',
  succeeded: '成功',
  failed: '失败',
} as const

export function ToolCard({ tool }: { tool: ToolItem }) {
  const summaryEntries = Object.entries(tool.resultSummary ?? {}).slice(0, 4)
  return (
    <div className={`rounded-lg border px-3 py-2 text-xs ${STATUS_STYLE[tool.status]}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[13px] text-slate-200">{tool.toolName}</span>
        <span className="flex items-center gap-2 text-slate-400">
          {tool.attempt > 1 && <span>第 {tool.attempt} 次尝试</span>}
          {tool.latencyMs !== undefined && <span>{tool.latencyMs}ms</span>}
          <span
            className={
              tool.status === 'succeeded'
                ? 'text-emerald-400'
                : tool.status === 'failed'
                  ? 'text-red-400'
                  : 'text-slate-300'
            }
          >
            {STATUS_LABEL[tool.status]}
          </span>
        </span>
      </div>
      {tool.errorCode && <div className="mt-1 font-mono text-red-400">{tool.errorCode}</div>}
      {summaryEntries.length > 0 && (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-slate-400">
          {summaryEntries.map(([key, value]) => (
            <div key={key} className="col-span-2 flex gap-3 truncate">
              <dt className="shrink-0 font-mono">{key}</dt>
              <dd className="truncate text-slate-300">{formatValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
