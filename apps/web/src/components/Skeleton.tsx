/**
 * 骨架屏占位
 *
 * 加载中用与最终布局同形的灰块占位 禁用通用转圈
 * 呼吸动效由 globals.css 的 prefers-reduced-motion 全局兜底
 */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-control bg-stone-200/70 ${className ?? ''}`}
    />
  )
}
