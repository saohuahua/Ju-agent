/**
 * 终端离线演示入口
 *
 * 演示依赖 better-sqlite3 原生二进制 需要与运行 Node 的 ABI 匹配
 * 这里先确保二进制就绪 再检查 Node 主版本 最后运行演示脚本
 * 找不到 Node 22 时给出明确提示 而不是抛出难以理解的绑定加载错误
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

/** 与 better-sqlite3 预编译包和项目手册一致的 Node 主版本 */
const REQUIRED_MAJOR = 22

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function ensureNativeDeps() {
  const result = spawnSync(process.execPath, ['scripts/ensure-native-deps.mjs'], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

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

function runDemo(nodePath) {
  const result = spawnSync(nodePath, ['--import', 'tsx', 'scripts/demo.ts'], {
    cwd: root,
    stdio: 'inherit',
  })
  process.exit(result.status ?? 1)
}

ensureNativeDeps()

if (Number(process.versions.node.split('.')[0]) === REQUIRED_MAJOR) {
  runDemo(process.execPath)
}

const fallback = findNode22()
if (fallback) {
  console.log(`[demo] 当前 Node ${process.versions.node} 与预编译二进制不匹配 改用 ${fallback}`)
  runDemo(fallback)
}

console.error(`[demo] 需要 Node ${REQUIRED_MAJOR} 当前为 ${process.versions.node}`)
console.error('[demo] 请安装 Node 22 或把它放到 PATH 前部后重新执行 pnpm demo')
console.error('[demo] 原因 better-sqlite3 11.10.0 没有该 Node 版本的预编译包')
process.exit(1)
