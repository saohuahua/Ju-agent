'use client'

/**
 * 物流更新卡片
 *
 * 工作台内嵌的物流事件展示 运营会话中途注入的物流状态变化
 * 延误与丢件分色呈现 忠实展示描述与运单信息
 * 视觉：hairline 白卡 + 左侧按状态着色的 2px 竖条 与 ToolCard 一致
 */

import type { LogisticsItem } from '@/lib/runReducer'

const STATUS_BAR = {
  delayed: 'bg-amber-500',
  lost: 'bg-red-500',
} as const

const STATUS_LABEL = {
  delayed: '运输延误',
  lost: '包裹丢失',
} as const

export function LogisticsCard({ item }: { item: LogisticsItem }) {
  return (
    <div className="relative mx-auto max-w-2xl rounded-container border border-hairline bg-white px-4 py-2.5">
      <span
        aria-hidden="true"
        className={`absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full ${STATUS_BAR[item.status]}`}
      />
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-stone-800">
          物流更新 {STATUS_LABEL[item.status]}
        </span>
        <span className="font-mono text-xs tabular-nums text-stone-400">
          {formatTime(item.injectedAt)}
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-stone-600">{item.description}</p>
      <p className="mt-1 font-mono text-[11px] text-stone-500">
        订单 {item.orderNo}
        {item.carrier && ` ${item.carrier}`}
        {item.trackingNo && ` ${item.trackingNo}`}
      </p>
    </div>
  )
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}
