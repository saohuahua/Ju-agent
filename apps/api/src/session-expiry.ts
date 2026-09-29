/**
 * 空闲会话扫描器
 *
 * API 进程内周期调用领域收尾 单条失败记日志不中断
 * 多进程重复扫描由状态 CAS 保证只收尾一次
 */

import type { SessionExpiryService } from '@aftersales/domain'

export function startSessionExpiryScanner(
  service: SessionExpiryService,
  intervalMs: number,
  signal?: AbortSignal,
): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new Error('SESSION_IDLE_SCAN_MS 过小')
  }
  let stopped = false
  const tick = () => {
    if (stopped) return
    void service.expireDue().then(
      (ids) => {
        if (ids.length > 0) console.log(`空闲会话已收尾 ${ids.join(' ')}`)
      },
      (error: unknown) => {
        console.error('空闲会话扫描失败', error)
      },
    )
  }
  tick()
  const timer = setInterval(tick, intervalMs)
  const stop = () => {
    stopped = true
    clearInterval(timer)
  }
  signal?.addEventListener('abort', stop, { once: true })
  return stop
}
