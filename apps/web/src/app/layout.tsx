import type { Metadata } from 'next'
import './globals.css'
import { Providers } from '@/components/Providers'
import { AppShell } from '@/components/AppShell'

export const metadata: Metadata = {
  title: '有据 · AfterSales 售后工作台',
  description: '可评测 可恢复的电商售后 Agent 平台',
  icons: {
    icon: '/icon.svg',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-canvas font-sans text-ink antialiased">
        {/* 公共外壳跨路由保留 身份变化仍由查询提供器重建整棵子树 */}
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  )
}
