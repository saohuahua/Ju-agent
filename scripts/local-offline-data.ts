import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertOfflineStopped } from './local-offline-lock.js'
import { businessPath, channelPath, projectRoot } from './local-offline-paths.js'

const action = process.argv[2]
if (action !== 'backup' && action !== 'restore') {
  throw new Error('仅支持 backup 或 restore')
}

assertOfflineStopped()
if (action === 'backup' && (!existsSync(businessPath) || !existsSync(channelPath))) {
  throw new Error('本地双库尚未初始化 请先运行 pnpm dev:offline')
}

const supplied = process.argv[3]
if (action === 'restore' && !supplied) throw new Error('恢复时必须提供备份目录')
const target = resolve(
  supplied ??
    resolve(
      projectRoot,
      'artifacts/offline-backups',
      new Date().toISOString().replaceAll(':', '-'),
    ),
)
const env = { ...process.env, DB_PATH: businessPath, P6_CHANNEL_DB_PATH: channelPath }

function run(mode: string) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/p10-data.ts', mode, target],
    {
      cwd: projectRoot,
      env,
      stdio: 'inherit',
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (action === 'backup') run('integrity')
run(action)
if (action === 'restore') run('integrity')
console.log(`${action === 'backup' ? '备份' : '恢复'}目录 ${target}`)
