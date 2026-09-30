'use client'

import { useSyncExternalStore } from 'react'
import { currentToken } from './api'

// 身份变更同步通知查询缓存与事件订阅
function subscribe(listener: () => void) {
  window.addEventListener('aftersales:identity', listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener('aftersales:identity', listener)
    window.removeEventListener('storage', listener)
  }
}

export function useIdentity() {
  const token = useSyncExternalStore(subscribe, currentToken, () => 'operator-token')
  const ready = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  )
  const role =
    token === 'supervisor-token'
      ? 'supervisor'
      : token === 'operator-token'
        ? 'operator'
        : 'customer'
  return { token, role, ready } as const
}
