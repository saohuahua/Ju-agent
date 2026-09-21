import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'AfterSales Copilot 售后工作台',
  description: '可评测 可恢复的电商售后 Agent 平台',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-canvas font-sans text-ink antialiased">{children}</body>
    </html>
  )
}
