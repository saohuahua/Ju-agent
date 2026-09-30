'use client'

import { useEffect, useRef, useState } from 'react'

/** 基础追赶速率 每秒显示的码点数 对齐常见中文阅读流速 */
const BASE_CPS = 45
/** 每个积压码点的附加速率 积压越大追赶越快 保证显示始终贴近目标 */
const CPS_PER_BACKLOG = 5
/** 目标一次领先超过该码点数视为批量回放或重放 直接吸附 不逐字追赶 */
const BURST_SNAP_LIMIT = 120

/**
 * 计算下一帧的显示游标 纯函数 便于测试与速率调参
 *
 * 推进量与帧间隔时长线性换算 动画帧率不影响每秒总量
 * 速率随积压线性增加 短增量保持匀速 长积压快速追赶
 * cursor 与返回值均为浮点码点游标 显示层向下取整保证不越界
 */
export function nextCursor(cursor: number, targetLength: number, elapsedMs: number): number {
  if (cursor >= targetLength) return targetLength
  const backlog = targetLength - cursor
  const cps = BASE_CPS + backlog * CPS_PER_BACKLOG
  return Math.min(targetLength, cursor + (cps * elapsedMs) / 1000)
}

/** 用户系统偏好减少动效时跳过打字 直接显示目标文本 CSS 跳点由全局降级规则处理 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * 流式文本打字机
 *
 * 目标文本由 SSE delta 推进 显示层用动画帧按固定节奏追赶
 * 抖动的增量被平滑成匀速输出 积压越大追赶越快 显示始终贴近目标
 * 三种情况直接吸附目标文本 权威完成帧 目标前缀回退(脱敏覆盖) 批量回放
 * 按码点切片 代理对不会拆成乱码
 */
export function useTypewriter(target: string, active: boolean): string {
  // 非流式挂载的历史消息直接完整显示 流式挂载从空文本开始逐字追赶
  const [shown, setShown] = useState(() => (active ? '' : target))
  const cursor = useRef(active ? 0 : Array.from(target).length)

  useEffect(() => {
    const points = Array.from(target)
    const shownText = points.slice(0, Math.floor(cursor.current)).join('')
    // 吸附条件 完成帧 目标不包含已显示前缀 积压超出批量阈值 用户偏好减少动效
    // 权威文本不允许被动画截断也不能被超出 显示层必须立刻对齐
    if (
      !active ||
      prefersReducedMotion() ||
      !target.startsWith(shownText) ||
      points.length - cursor.current > BURST_SNAP_LIMIT
    ) {
      cursor.current = points.length
      setShown(target)
      return
    }
    if (cursor.current >= points.length) return
    let frame = 0
    let last = performance.now()
    const step = (now: number) => {
      cursor.current = nextCursor(cursor.current, points.length, now - last)
      last = now
      setShown(points.slice(0, Math.floor(cursor.current)).join(''))
      if (cursor.current < points.length) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    // 目标更新会重启追赶 旧帧必须取消 避免双帧叠加重复推进
    return () => cancelAnimationFrame(frame)
  }, [target, active])

  return shown
}
