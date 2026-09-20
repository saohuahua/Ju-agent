'use client'

/**
 * 应用外壳
 *
 * 全局导航与演示身份切换
 * 组件约定见 apps/web/CONVENTIONS.md
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { DEMO_TOKENS, currentToken, setToken } from '@/lib/api'

const NAV_ITEMS = [
  { href: '/workbench', label: '会话工作台' },
  { href: '/approvals', label: '审批中心' },
  { href: '/runs', label: '运行记录' },
  { href: '/eval', label: '评测看板' },
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
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-900/60">
        <div className="border-b border-slate-800 px-5 py-4">
          <div className="text-base font-semibold">AfterSales Copilot</div>
          <div className="mt-1 text-xs text-slate-400">可评测 可恢复的售后 Agent</div>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-4">
          {NAV_ITEMS.map((item) => {
            const active = pathname.startsWith(item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                  active ? 'bg-sky-600 text-white' : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div className="border-t border-slate-800 px-3 py-4">
          <div className="mb-2 text-xs text-slate-400">演示身份</div>
          <select
            value={token}
            onChange={(event) => switchToken(event.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-200"
            aria-label="切换演示身份"
          >
            {DEMO_TOKENS.map((demo) => (
              <option key={demo.value} value={demo.value}>
                {demo.label}
              </option>
            ))}
          </select>
          <p className="mt-2 text-[11px] leading-4 text-slate-500">
            演示环境令牌 生产环境应替换为正式认证
          </p>
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden">{children}</main>
    </div>
  )
}
