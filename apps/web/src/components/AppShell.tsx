'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowUpRight, Inbox } from 'lucide-react'

import { DEMO_TOKENS, setToken } from '@/lib/api'
import { useIdentity } from '@/lib/identity'
import { isNavItemActive, pageTitle, STAFF_NAVIGATION } from '@/lib/nav'
import { cn } from '@/lib/utils'

/**
 * 应用外壳提供统一品牌导航与演示身份切换
 * 客户入口只展示客户自己的操作范围
 * 身份更新会通知查询缓存和事件流一起重建
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { token, role } = useIdentity()
  const isCustomer = role === 'customer'

  return (
    <div className="youju-shell">
      <a href="#main-content" className="youju-skip">
        跳到主内容
      </a>

      <aside className="youju-sidebar">
        <Link
          href={isCustomer ? '/workbench' : '/console'}
          className="youju-brand"
          aria-label="有据售后平台首页"
        >
          <span className="youju-wordmark">据</span>
          <span>
            有据<small>AFTERSALES</small>
          </span>
        </Link>

        <div className="youju-team">
          <span>售</span>
          <div>
            售后服务团队<small>本地演示工作空间</small>
          </div>
        </div>

        <p className="youju-nav-label">{isCustomer ? '我的售后' : '工作空间'}</p>

        <nav aria-label="主导航">
          {isCustomer ? (
            <Link className="youju-nav active" href="/workbench" aria-current="page">
              <Inbox />
              客户服务
            </Link>
          ) : (
            STAFF_NAVIGATION.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn('youju-nav', isNavItemActive(href, pathname) && 'active')}
                aria-current={isNavItemActive(href, pathname) ? 'page' : undefined}
              >
                <Icon aria-hidden="true" />
                {label}
              </Link>
            ))
          )}
        </nav>

        <div className="youju-sidebar-footer">
          {!isCustomer && (
            <Link href="/workbench" className="youju-entry">
              客户服务入口
              <ArrowUpRight aria-hidden="true" />
            </Link>
          )}

          <label htmlFor="demo-identity" className="youju-identity-label">
            演示身份
          </label>
          <select
            id="demo-identity"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          >
            {DEMO_TOKENS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>

          <p className="youju-environment">
            模拟业务环境
            <br />
            数据与处理记录由服务端保存
          </p>
        </div>
      </aside>

      <div className="youju-main">
        <header className="youju-topbar">
          <div>
            工作空间<span>/</span>
            <strong>{pageTitle(pathname)}</strong>
          </div>
          <span className="youju-local">本地演示</span>
        </header>

        <main id="main-content" className="youju-content">
          {children}
        </main>
      </div>
    </div>
  )
}
