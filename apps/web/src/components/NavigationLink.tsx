'use client'

import Link, { useLinkStatus } from 'next/link'
import type { ComponentProps } from 'react'

/**
 * 导航反馈使用框架维护的过渡状态
 * 保留链接默认的键盘操作 新标签页和历史记录行为
 * 当前页面标记仍由真实路径决定 避免尚未到达就显示已选中
 * 等待标记供公共外壳的顶部指示条读取 不维护另一个容易失步的导航计数器
 * 快速导航和取消由框架清理 pending 缓存命中没有等待时不强制播放动画
 * 修改键点击和新标签页继续使用 Link 默认行为 不拦截浏览器原生导航
 */
export function NavigationLink({ children, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link {...props}>
      {children}
      <NavigationFeedback />
    </Link>
  )
}

function NavigationFeedback() {
  const { pending } = useLinkStatus()

  return (
    <span className="youju-navigation-feedback" data-pending={pending} role="status">
      {pending && <span className="sr-only">正在打开页面</span>}
    </span>
  )
}
