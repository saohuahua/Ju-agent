'use client'

/**
 * 自绘图表组件
 *
 * 规格遵循 dataviz 规范 条厚不超过 24px 数据端 4px 圆角基线端方角
 * 单 sage 色系 文本一律用 ink token 不着数据色 直接标签稀疏放置
 * 悬停高亮与 title 提示 每图有数值标注兜底 交叉分析用数据表
 */

/** 水平条形图 数据端 4px 圆角 值标签在条尾 */
export function HBarList({
  items,
  formatValue,
  tone = 'sage',
}: {
  items: Array<{ label: string; value: number; note?: string }>
  formatValue?: (value: number) => string
  tone?: 'sage' | 'amber'
}) {
  const max = Math.max(...items.map((item) => item.value), 1)
  return (
    <div className="space-y-2.5">
      {items.map((item) => {
        const widthPct = Math.max((item.value / max) * 100, item.value > 0 ? 2 : 0)
        const fill =
          tone === 'sage'
            ? 'bg-sage-600 group-hover:bg-sage-500'
            : 'bg-amber-500 group-hover:bg-amber-400'
        return (
          <div
            key={item.label}
            className="group flex items-center gap-3"
            title={item.note ?? item.label}
          >
            <span className="w-36 shrink-0 truncate text-xs text-stone-600" title={item.label}>
              {item.label}
            </span>
            <div className="h-4 min-w-0 flex-1">
              <div
                className={`h-full rounded-r-[4px] transition-colors duration-200 ${fill}`}
                style={{ width: `${widthPct}%` }}
              />
            </div>
            <span className="w-16 shrink-0 text-right text-xs tabular-nums text-stone-500">
              {formatValue ? formatValue(item.value) : item.value}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** 按日趋势列图 单系列 无图例 值标签只标峰值与末值 */
export function DayTrendColumns({ data }: { data: Array<{ day: string; count: number }> }) {
  const max = Math.max(...data.map((item) => item.count), 1)
  return (
    <div className="flex h-32 items-end gap-[3px]">
      {data.map((item, index) => {
        const isLast = index === data.length - 1
        const isPeak = item.count === max && max > 0
        const heightPx = Math.max((item.count / max) * 88, item.count > 0 ? 4 : 2)
        return (
          <div
            key={item.day}
            className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end"
            title={`${item.day} ${item.count} 条会话`}
          >
            <span className="mb-1 h-4 text-[10px] tabular-nums text-stone-500">
              {isPeak || isLast ? item.count : ''}
            </span>
            <div
              className={`w-full max-w-6 rounded-t-[4px] transition-colors duration-200 ${
                isPeak ? 'bg-sage-600' : 'bg-sage-400 group-hover:bg-sage-500'
              }`}
              style={{ height: `${heightPx}px` }}
            />
            <span
              className="mt-1 w-full truncate text-center text-[9px] text-stone-400"
              title={item.day}
            >
              {item.day.slice(5)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** 满意度分布 1-5 星离散列 每列值标在帽上 不设 y 轴 */
export function RatingColumns({ counts }: { counts: Array<{ score: number; count: number }> }) {
  const byScore = [1, 2, 3, 4, 5].map(
    (score) => counts.find((entry) => entry.score === score)?.count ?? 0,
  )
  const max = Math.max(...byScore, 1)
  return (
    <div className="flex h-28 items-end justify-between gap-3">
      {byScore.map((count, index) => {
        const score = index + 1
        const heightPx = Math.max((count / max) * 80, count > 0 ? 4 : 2)
        return (
          <div
            key={score}
            className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end"
            title={`${score} 星 ${count} 条`}
          >
            <span className="mb-1 text-[10px] tabular-nums text-stone-500">{count}</span>
            <div
              className="w-full max-w-10 rounded-t-[4px] bg-sage-600 transition-colors duration-200 group-hover:bg-sage-500"
              style={{ height: `${heightPx}px` }}
            />
            <span className="mt-1 text-[10px] text-stone-500">{score} 星</span>
          </div>
        )
      })}
    </div>
  )
}

/** 指标卡 label 加 value 辅注 可选强调色 */
export function MetricTile({
  label,
  value,
  sub,
  tone = 'ink',
}: {
  label: string
  value: string
  sub?: string
  tone?: 'ink' | 'sage' | 'amber'
}) {
  const valueClass =
    tone === 'sage' ? 'text-sage-700' : tone === 'amber' ? 'text-amber-700' : 'text-stone-900'
  return (
    <div className="rounded-container border border-hairline bg-surface px-4 py-3">
      <div className="text-xs text-stone-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tracking-tight ${valueClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-stone-400">{sub}</div>}
    </div>
  )
}

/** 通用比例条 0 到 1 的单值仪表 轨道用同色浅阶 */
export function RatioMeter({
  value,
  tone = 'sage',
}: {
  value: number
  tone?: 'sage' | 'amber' | 'red'
}) {
  const track = tone === 'sage' ? 'bg-sage-100' : tone === 'amber' ? 'bg-amber-100' : 'bg-red-100'
  const fill = tone === 'sage' ? 'bg-sage-600' : tone === 'amber' ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className={`h-2 w-full overflow-hidden rounded-full ${track}`}>
      <div
        className={`h-full rounded-full ${fill} transition-[width] duration-500`}
        style={{ width: `${Math.min(Math.max(value * 100, 0), 100)}%` }}
      />
    </div>
  )
}
