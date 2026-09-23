/**
 * 全站信息架构
 *
 * 导航分四组本身在讲产品结构：有前台 有后台 有工程面（v4 计划 D6）。
 * 路由到主题的映射也在这里收口——客户侧浅色 其余深色（ADR-013），
 * AppShell 与各页面共享同一份判定 避免两处各写一遍导致深浅错配。
 *
 * 尚未落地的页面以 status: 'planned' 登记：分组结构从第一天就完整可见，
 * 但不给出会 404 的链接。功能落地时把 status 改成 'ready' 即可。
 */

import {
  ChartBar,
  ChatsCircle,
  CheckSquareOffset,
  ClockCounterClockwise,
  Gauge,
  Headset,
  Receipt,
  Scroll,
  ShieldWarning,
  TrendUp,
  type Icon,
} from '@phosphor-icons/react'

/** 主题轨：客户侧浅色安抚 其余深色暴露系统真相 */
export type ThemeTrack = 'light' | 'console'

/** 页面状态：ready 可访问 planned 占位不可点 */
export type NavStatus = 'ready' | 'planned'

export interface NavItem {
  href: string
  label: string
  icon: Icon
  status: NavStatus
}

export interface NavGroup {
  /** 分组标题 侧边栏以小号字母间距拉开的 label 呈现 */
  title: string
  /** 该组页面所属主题轨 组内保持一致 */
  track: ThemeTrack
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: '总览',
    track: 'console',
    items: [{ href: '/', label: '驾驶舱', icon: Gauge, status: 'planned' }],
  },
  {
    title: '客户侧',
    track: 'light',
    items: [
      { href: '/workbench', label: '会话工作台', icon: ChatsCircle, status: 'ready' },
      { href: '/my', label: '我的售后单', icon: Receipt, status: 'planned' },
    ],
  },
  {
    title: '运营侧',
    track: 'console',
    items: [
      { href: '/console', label: '坐席工作台', icon: Headset, status: 'ready' },
      { href: '/approvals', label: '审批中心', icon: CheckSquareOffset, status: 'ready' },
      { href: '/analytics', label: '运营分析', icon: TrendUp, status: 'ready' },
      { href: '/policies', label: '政策管理', icon: Scroll, status: 'planned' },
    ],
  },
  {
    title: '工程侧',
    track: 'console',
    items: [
      { href: '/runs', label: '运行记录', icon: ClockCounterClockwise, status: 'ready' },
      { href: '/eval', label: '评测看板', icon: ChartBar, status: 'ready' },
      { href: '/sandbox', label: '对抗沙箱', icon: ShieldWarning, status: 'planned' },
    ],
  },
]

/** 客户侧路由前缀 命中即走浅色轨 其余一律深色控制台 */
const LIGHT_TRACK_PREFIXES = NAV_GROUPS.filter((group) => group.track === 'light').flatMap(
  (group) => group.items.map((item) => item.href),
)

/**
 * 解析路由所属主题轨
 *
 * 根路径 / 是驾驶舱 属深色 不能用前缀匹配（任何路径都以 / 开头）故单独判定。
 */
export function resolveTrack(pathname: string): ThemeTrack {
  if (pathname === '/') return 'console'
  return LIGHT_TRACK_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ? 'light' : 'console'
}

/** 判定导航项是否处于激活态 根路径要求精确匹配 其余按前缀 */
export function isNavItemActive(href: string, pathname: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href)
}
