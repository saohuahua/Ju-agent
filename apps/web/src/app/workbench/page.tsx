'use client'

import { AppShell } from '@/components/AppShell'
import { CustomerWorkspace } from '@/components/customer/CustomerWorkspace'

export default function WorkbenchPage() {
  return (
    <AppShell>
      <CustomerWorkspace />
    </AppShell>
  )
}
