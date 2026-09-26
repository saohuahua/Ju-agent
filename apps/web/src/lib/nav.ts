import {
  BookOpen,
  ChartNoAxesCombined,
  Inbox,
  Settings2,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
}

/**
 * 团队导航围绕实际处理任务组织
 * 只登记已经有页面的入口避免展示无法使用的占位功能
 * 角色权限仍由服务端校验而不是由导航是否可见决定
 */
export const STAFF_NAVIGATION: NavItem[] = [
  { href: '/console', label: '处理工作台', icon: Inbox },
  { href: '/approvals', label: '待审批事项', icon: ShieldCheck },
  { href: '/policies', label: '知识与政策', icon: BookOpen },
  { href: '/eval', label: '质量与运行', icon: ChartNoAxesCombined },
  { href: '/settings', label: '运行设置', icon: Settings2 },
]

/** 子页面只能匹配完整路径段避免相似前缀误选导航 */
export function isNavItemActive(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function pageTitle(pathname: string): string {
  const item = STAFF_NAVIGATION.find((entry) => isNavItemActive(entry.href, pathname))

  if (item) return item.label
  if (pathname.startsWith('/runs')) return '运行记录'
  if (pathname.startsWith('/analytics')) return '运营分析'

  return '客户售后'
}
