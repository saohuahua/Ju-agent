'use client'

/**
 * 应用外壳
 *
 * 侧边栏恒为深色——它属于外壳不属于任何一轨；主区域按路由切轨，
 * 进入客户侧时深浅交界本身就是「前台/后台」的视觉证据（ADR-013）。
 *
 * 信息架构与路由到主题的映射见 lib/nav.ts
 * 组件约定见 apps/web/CONVENTIONS.md
 * 视觉规范见 docs/redesign-audit.md 第 4.6 节
 */

import { ShieldCheck } from '@phosphor-icons/react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { DEMO_TOKENS, currentToken, setToken } from '@/lib/api'
import { NAV_GROUPS, isNavItemActive, resolveTrack, type NavItem } from '@/lib/nav'

/** 单个导航项 planned 状态渲染为不可点占位 保持分组结构完整又不给出 404 链接 */
function NavEntry({ item, pathname }: { item: NavItem; pathname: string }) {
  const NavIcon = item.icon

  if (item.status === 'planned') {
    return (
      <span
        aria-disabled="true"
        title="开发中"
        className="flex cursor-default items-center gap-2.5 rounded-control px-3 py-2 text-sm text-console-dim"
      >
        <NavIcon size={18} aria-hidden="true" className="shrink-0" />
        <span className="flex-1 truncate">{item.label}</span>
        <span className="shrink-0 rounded-badge border border-console-hairline px-1.5 py-px text-[10px] text-console-dim">
          待建
        </span>
      </span>
    )
  }

  const active = isNavItemActive(item.href, pathname)
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={`relative flex items-center gap-2.5 rounded-control px-3 py-2 text-sm transition-colors duration-200 active:scale-[0.99] ${
        active
          ? 'bg-console-raised font-medium text-console-ink'
          : 'text-console-muted hover:bg-console-surface hover:text-console-ink'
      }`}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-console-accent"
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
}

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

  const track = resolveTrack(pathname)

  return (
    <div className="flex min-h-screen">
      <aside
        data-theme="console"
        className="flex w-56 shrink-0 flex-col border-r border-console-hairline bg-console-canvas"
      >
        <div className="flex items-center gap-2.5 border-b border-console-hairline px-4 py-4">
          <span className="rounded-control bg-console-raised p-1.5 text-console-accent">
            <ShieldCheck size={20} weight="fill" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold tracking-tight text-console-ink">
              AfterSales Copilot
            </div>
            <div className="mt-0.5 truncate text-xs text-console-muted">
              可评测 · 可恢复的售后 Agent
            </div>
          </div>
        </div>

        <nav aria-label="主导航" className="flex-1 overflow-y-auto px-3 py-4">
          {NAV_GROUPS.map((group, index) => (
            <div
              key={group.title}
              className={index > 0 ? 'mt-4 border-t border-console-hairline pt-4' : undefined}
            >
              <div className="px-3 pb-1.5 text-[10px] font-medium tracking-[0.14em] text-console-dim uppercase">
                {group.title}
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavEntry key={item.href} item={item} pathname={pathname} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-console-hairline px-3 py-4">
          <label
            htmlFor="demo-identity"
            className="block text-[11px] tracking-wider text-console-dim"
          >
            演示身份
          </label>
          <select
            id="demo-identity"
            value={token}
            onChange={(event) => switchToken(event.target.value)}
            className="mt-1.5 w-full rounded-control border border-console-border bg-console-surface px-2.5 py-1.5 text-xs text-console-ink transition-colors duration-200 hover:border-console-accent-dim"
          >
            {DEMO_TOKENS.map((demo) => (
              <option key={demo.value} value={demo.value}>
                {demo.label}
              </option>
            ))}
          </select>
          <p className="mt-2 text-[11px] leading-4 text-console-dim">
            演示环境令牌，生产环境应替换为正式认证。
          </p>
        </div>
      </aside>

      {/*
        主区域按路由切轨。浅色轨不标注 data-theme，沿用 :root 的浅色默认值；
        深色轨标注后由 globals.css 的 [data-theme='console'] 作用域接管。
      */}
      <main
        data-theme={track === 'console' ? 'console' : undefined}
        className={`flex-1 overflow-x-hidden ${
          track === 'console' ? 'bg-console-canvas text-console-ink' : 'bg-canvas text-ink'
        }`}
      >
        {children}
      </main>
    </div>
  )
}
