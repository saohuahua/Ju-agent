'use client'

import { useEffect, useState } from 'react'

/**
 * 输入框即时更新 查询条件在用户停顿后提交
 * 新输入和组件卸载都会清理旧定时器 避免过时条件触发请求
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])

  return settled
}
