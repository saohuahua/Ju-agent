'use client'

import { usePathname } from 'next/navigation'
import { ArrowUpRight, Inbox } from 'lucide-react'

import { DEMO_TOKENS, setToken } from '@/lib/api'
import { useIdentity } from '@/lib/identity'
import { isNavItemActive, pageTitle, STAFF_NAVIGATION } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { NavigationLink } from './NavigationLink'

/**
 * 应用外壳由根布局挂载 普通换页保留侧栏和顶栏节点
 * 客户入口只展示客户自己的操作范围
 * 身份更新会通知查询缓存和事件流一起重建
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { token, role } = useIdentity()
  const isCustomer = role === 'customer'

  return (
    <div className="youju-shell">
      {/* 导航标记和路由占位共同驱动指示条 不把后台数据轮询视作换页 */}
      {/* 指示条只表达等待 不展示无法由路由状态核验的百分比 */}
      <div className="youju-navigation-progress" aria-hidden="true">
        <span />
      </div>
      <a href="#main-content" className="youju-skip">
        跳到主内容
      </a>

      <aside className="youju-sidebar">
        <NavigationLink
          href={isCustomer ? '/workbench' : '/console'}
          className="youju-brand"
          aria-label="有据售后平台首页"
        >
          <span className="youju-wordmark">据</span>
          <span>
            有据<small>AFTERSALES</small>
          </span>
        </NavigationLink>

        <div className="youju-team">
          <span>售</span>
          <div>
            售后服务团队<small>客户与团队协作</small>
          </div>
        </div>

        <p className="youju-nav-label">{isCustomer ? '我的售后' : '工作空间'}</p>

        <nav aria-label="主导航">
          {isCustomer ? (
            <NavigationLink className="youju-nav active" href="/workbench" aria-current="page">
              <Inbox />
              客户服务
            </NavigationLink>
          ) : (
            STAFF_NAVIGATION.map(({ href, label, icon: Icon }) => (
              <NavigationLink
                key={href}
                href={href}
                className={cn('youju-nav', isNavItemActive(href, pathname) && 'active')}
                aria-current={isNavItemActive(href, pathname) ? 'page' : undefined}
              >
                <Icon aria-hidden="true" />
                {label}
              </NavigationLink>
            ))
          )}
        </nav>

        <div className="youju-sidebar-footer">
          {!isCustomer && (
            <NavigationLink href="/workbench" className="youju-entry">
              客户服务入口
              <ArrowUpRight aria-hidden="true" />
            </NavigationLink>
          )}

          <label htmlFor="demo-identity" className="youju-identity-label">
            当前身份
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
            订单与支付为模拟
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
          <span className="youju-local">本地运行</span>
        </header>

        <main id="main-content" className="youju-content">
          {children}
        </main>
      </div>
    </div>
  )
}
