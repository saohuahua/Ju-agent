'use client'

import { CaseWorkspace } from '@/components/desk/CaseWorkspace'

// 页面只挂载受身份保护的案件工作区 公共导航由根布局保留
export default function ConsolePage() {
  return <CaseWorkspace />
}
