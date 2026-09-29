'use client'

import { useRef } from 'react'

/** 分隔线支持指针捕获和方向键调整 */
export function SplitHandle({
  label,
  value,
  min,
  max,
  onDelta,
}: {
  label: string
  value: number
  min: number
  max: number
  onDelta: (delta: number) => void
}) {
  const lastX = useRef<number | null>(null)
  return (
    <div
      className="desk-split"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        lastX.current = event.clientX
      }}
      onPointerMove={(event) => {
        if (lastX.current === null) return
        onDelta(event.clientX - lastX.current)
        lastX.current = event.clientX
      }}
      onPointerUp={() => {
        lastX.current = null
      }}
      onLostPointerCapture={() => {
        lastX.current = null
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        onDelta(event.key === 'ArrowLeft' ? -16 : 16)
      }}
    />
  )
}
