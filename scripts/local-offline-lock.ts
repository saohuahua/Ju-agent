import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { localOfflineRoot, runningPath } from './local-offline-paths.js'

export function assertOfflineStopped(): void {
  if (!existsSync(runningPath)) return
  // 异常退出后清理失效标记 保留活动进程的标记
  const pid = Number(readFileSync(runningPath, 'utf8'))
  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0)
      throw new Error('本地离线服务仍在运行 请先在启动窗口按 Ctrl+C')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  unlinkSync(runningPath)
}

export function markOfflineRunning(): void {
  mkdirSync(localOfflineRoot, { recursive: true })
  assertOfflineStopped()
  writeFileSync(runningPath, String(process.pid), { flag: 'wx' })
}

export function clearOfflineRunning(): void {
  if (existsSync(runningPath) && readFileSync(runningPath, 'utf8') === String(process.pid)) {
    unlinkSync(runningPath)
  }
}
