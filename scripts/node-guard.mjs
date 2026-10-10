/**
 * Node 版本守卫
 *
 * 通过 node --import ./scripts/node-guard.mjs <脚本> 引入
 * better-sqlite3 11.10.0 没有 Node 24 的预编译二进制 也必须避免本地编译
 * 当前 Node 主版本不符时 改用它自己未使用的 Node 22 便携版重新执行同一命令
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const REQUIRED_MAJOR = 22
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 从 Windows 用户与系统 PATH 中找回 Node 22 便携版 旧终端没有刷新 PATH 时仍可运行 */
function findNode22() {
  if (process.platform !== 'win32') return null
  for (const scope of ['User', 'Machine']) {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Environment]::GetEnvironmentVariable('Path','${scope}')`,
      ],
      { encoding: 'utf8' },
    )
    if (result.status !== 0 || !result.stdout) continue
    for (const entry of result.stdout.trim().split(';')) {
      if (!entry) continue
      const candidate = join(entry, 'node.exe')
      if (!existsSync(candidate)) continue
      // 只接受主版本匹配的运行时 同一 PATH 上可能还装着其他 Node
      const version = spawnSync(candidate, ['-p', 'process.versions.node'], { encoding: 'utf8' })
      if (version.status !== 0 || !version.stdout) continue
      if (Number(version.stdout.trim().split('.')[0]) === REQUIRED_MAJOR) return candidate
    }
  }
  return null
}

if (Number(process.versions.node.split('.')[0]) !== REQUIRED_MAJOR) {
  const fallback = findNode22()
  if (fallback) {
    console.log(`[node-guard] 当前 Node ${process.versions.node} 改用 ${fallback}`)
    // 用 execArgv 还原 --import 等启动参数 再拼接入口脚本与业务参数
    const forwarded = [...process.execArgv, ...process.argv.slice(1)]
    const result = spawnSync(fallback, forwarded, { stdio: 'inherit', cwd: process.cwd() })
    process.exit(result.status ?? 1)
  }
  console.error(`[node-guard] 需要 Node ${REQUIRED_MAJOR} 当前为 ${process.versions.node}`)
  console.error('[node-guard] 请安装 Node 22 或把它放到 PATH 前部')
  console.error('[node-guard] 原因 better-sqlite3 11.10.0 没有该 Node 版本的预编译包')
  process.exit(1)
}
