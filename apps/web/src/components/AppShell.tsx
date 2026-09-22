'use client'

/**
 * 应用外壳
 *
 * 全局导航与演示身份切换
 * 组件约定见 apps/web/CONVENTIONS.md
 * 视觉规范见 docs/redesign-audit.md 第 4.6 节
 */

import {
  ChatsCircle,
  ChartBar,
  CheckSquareOffset,
  ClockCounterClockwise,
  Headset,
  ShieldCheck,
  type Icon,
} from '@phosphor-icons/react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { DEMO_TOKENS, currentToken, setToken } from '@/lib/api'

const NAV_ITEMS: Array<{ href: string; label: string; icon: Icon }> = [
  { href: '/workbench', label: '会话工作台', icon: ChatsCircle },
  { href: '/console', label: '坐席工作台', icon: Headset },
  { href: '/approvals', label: '审批中心', icon: CheckSquareOffset },
  { href: '/runs', label: '运行记录', icon: ClockCounterClockwise },
  { href: '/eval', label: '评测看板', icon: ChartBar },
]

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [token, setLocalToken] = useState(DEMO_TOKENS[0]!.value)

  useEffect(() => {
    setLocalToken(currentToken())
  }, [])

  const switchToken = (value: string) => {
    setToken(value)
    setLocalToken(value)
  }

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-hairline bg-surface">
        <div className="flex items-center gap-2.5 border-b border-hairline px-4 py-4">
          <span className="rounded-control bg-sage-100 p-1.5 text-sage-700">
            <ShieldCheck size={20} weight="fill" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold tracking-tight text-ink">
              AfterSales Copilot
            </div>
            <div className="mt-0.5 truncate text-xs text-stone-500">
              可评测 · 可恢复的售后 Agent
            </div>
          </div>
        </div>
        <nav aria-label="主导航" className="flex-1 space-y-0.5 px-3 py-4">
          {NAV_ITEMS.map((item) => {
            const active = pathname.startsWith(item.href)
            const NavIcon = item.icon
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`relative flex items-center gap-2.5 rounded-control px-3 py-2 text-sm transition-colors duration-200 active:scale-[0.99] ${
                  active
                    ? 'bg-sage-50 font-medium text-stone-900'
                    : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900'
                }`}
              >
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-sage-600"
                  />
                )}
                <NavIcon
                  size={18}
                  weight={active ? 'fill' : 'regular'}
                  aria-hidden="true"
                  className="shrink-0"
                />
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div className="border-t border-hairline px-3 py-4">
          <label
            htmlFor="demo-identity"
            className="block text-[11px] tracking-wider text-stone-400"
          >
            演示身份
          </label>
          <select
            id="demo-identity"
            value={token}
            onChange={(event) => switchToken(event.target.value)}
            className="mt-1.5 w-full rounded-control border border-hairline bg-white px-2.5 py-1.5 text-xs text-stone-700 transition-colors duration-200 hover:border-stone-300"
          >
            {DEMO_TOKENS.map((demo) => (
              <option key={demo.value} value={demo.value}>
                {demo.label}
              </option>
            ))}
          </select>
          <p className="mt-2 text-[11px] leading-4 text-stone-400">
            演示环境令牌，生产环境应替换为正式认证。
          </p>
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden">{children}</main>
    </div>
  )
}
