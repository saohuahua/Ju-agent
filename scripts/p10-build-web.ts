import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

// 独立构建目录只复制已列出的源码 不读取源目录环境文件
const root = process.cwd()
mkdirSync('artifacts/p10-build', { recursive: true })
const target = mkdtempSync(resolve('artifacts/p10-build/web-'))
const web = join(target, 'apps/web')
mkdirSync(web, { recursive: true })
for (const path of [
  'src',
  'public',
  'package.json',
  'tsconfig.json',
  'next.config.ts',
  'next-env.d.ts',
  'postcss.config.mjs',
]) {
  cpSync(join(root, 'apps/web', path), join(web, path), { recursive: true })
}
cpSync('tsconfig.base.json', join(target, 'tsconfig.base.json'))
symlinkSync(join(root, 'apps/web/node_modules'), join(web, 'node_modules'), 'junction')
const env: NodeJS.ProcessEnv = Object.fromEntries(
  [
    'PATH',
    'Path',
    'SystemRoot',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
  ].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
)
Object.assign(env, {
  NEXT_PUBLIC_API_BASE: '',
  OFFLINE_DEPLOYMENT: '1',
  NEXT_TELEMETRY_DISABLED: '1',
})
const child = spawn(
  process.execPath,
  [join(root, 'apps/web/node_modules/next/dist/bin/next'), 'build', web],
  { cwd: web, env, windowsHide: true },
)
let log = ''
child.stdout.on('data', (data) => {
  log += String(data)
  process.stdout.write(data)
})
child.stderr.on('data', (data) => {
  log += String(data)
  process.stderr.write(data)
})
child.once('close', (code) => {
  writeFileSync(join(target, 'build.log'), log)
  console.log(`独立生产构建 ${target} 退出码 ${code}`)
  process.exitCode = code ?? 1
})
