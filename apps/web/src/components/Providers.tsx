'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useIdentity } from '@/lib/identity'

// 身份变化时整体更换缓存并重建子树
export function Providers({ children }: { children: React.ReactNode }) {
  const { token, ready } = useIdentity()
  const client = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 5_000, retry: false, refetchOnWindowFocus: true },
          mutations: { retry: false },
        },
      }),
    [token],
  )
  // 服务端无法读取本地演示身份 确认身份前不挂载员工页面或发出其查询
  if (!ready)
    return (
      <p role="status" className="p-6">
        正在确认身份
      </p>
    )

  return (
    <QueryClientProvider key={token} client={client}>
      {children}
    </QueryClientProvider>
  )
}
