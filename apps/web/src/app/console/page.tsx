'use client'

import { AppShell } from '@/components/AppShell'
import { CaseWorkspace } from '@/components/desk/CaseWorkspace'

// 工作台页面只负责组合外壳与受身份保护的案件工作区
export default function ConsolePage() {
  return (
    <AppShell>
      <CaseWorkspace />
    </AppShell>
  )
}
