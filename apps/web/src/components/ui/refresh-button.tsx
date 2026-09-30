'use client'

import { useRef, useState, type ComponentProps } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from './button'

/**
 * 只展示当前按钮发起的刷新状态
 * 后台轮询可以通过 disabled 阻止重复请求 但不会触发图标旋转
 * onRefresh 必须返回实际请求的 Promise 不能只发起请求后立即返回
 * 查询失败的业务提示由页面负责 此处同时提供读屏反馈并保证释放按钮
 * 同步锁防止连续点击在 React 更新界面之前重复发起请求
 */
export function RefreshButton({
  onRefresh,
  children,
  disabled,
  ...props
}: Omit<ComponentProps<typeof Button>, 'onClick' | 'loading' | 'asChild'> & {
  onRefresh: () => Promise<unknown>
}) {
  const locked = useRef(false)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState('')

  async function refresh() {
    if (locked.current || disabled) return
    locked.current = true
    setRefreshing(true)
    setNotice('正在刷新')
    try {
      const result = await onRefresh()
      const failed = result && typeof result === 'object' && 'isError' in result && result.isError
      setNotice(failed ? '刷新失败 请重试' : '刷新完成')
    } catch {
      setNotice('刷新失败 请重试')
    } finally {
      locked.current = false
      setRefreshing(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        {...props}
        disabled={disabled || refreshing}
        aria-busy={refreshing}
        data-refreshing={refreshing}
        onClick={() => void refresh()}
      >
        <RefreshCw className={refreshing ? 'youju-spin' : undefined} aria-hidden="true" />
        {children}
      </Button>
      <span className="sr-only" role="status">
        {notice}
      </span>
    </>
  )
}
