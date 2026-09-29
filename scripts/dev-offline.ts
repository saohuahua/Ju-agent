import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { existsSync } from 'node:fs'
import { clearOfflineRunning, markOfflineRunning } from './local-offline-lock.js'
import { businessPath, channelPath, projectRoot } from './local-offline-paths.js'

const root = projectRoot
const envFile = resolve(root, '.env')
if (existsSync(envFile)) loadEnvFile(envFile)
const webRoot = resolve(root, 'apps/web')
const nextCli = resolve(webRoot, 'node_modules/next/dist/bin/next')
// 显式覆盖业务模式和代理地址 避免外部环境改变本地离线入口
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'development',
  P6_BUSINESS_MODE: 'simulation',
  P6_EMBEDDED_SIMULATOR: '1',
  API_HOST: '127.0.0.1',
  DB_PATH: businessPath,
  P6_CHANNEL_DB_PATH: channelPath,
  NEXT_PUBLIC_API_BASE: '',
  OFFLINE_DEPLOYMENT: '1',
  OFFLINE_DEV_INSTANCE: '1',
}
const webEnv = { ...env }
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MODEL_LOCAL_TOKEN']) {
  delete webEnv[key]
}

const children: ChildProcess[] = []
let stopping = false

function start(name: string, cwd: string, args: string[], childEnv = env) {
  const child = spawn(process.execPath, args, { cwd, env: childEnv, stdio: 'inherit', windowsHide: true })
  children.push(child)
  child.once('error', (error) => {
    console.error(`${name} 启动失败`, error)
    process.exitCode = 1
    stop()
  })
  child.once('exit', (code, signal) => {
    if (stopping) return
    console.error(`${name} 已退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`)
    process.exitCode = code && code > 0 ? code : 1
    stop()
  })
  return child
}

function stop() {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  if (children.every((child) => child.exitCode !== null || child.signalCode !== null)) {
    clearOfflineRunning()
  }
}

process.once('exit', clearOfflineRunning)

process.once('SIGINT', stop)
process.once('SIGTERM', stop)

async function freePort(preferred: number): Promise<number> {
  const listen = (port: number, host: string) =>
    new Promise<number>((done, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(port, host, () => {
        const selected = (server.address() as { port: number }).port
        server.close(() => done(selected))
      })
    })
  try {
    const port = await listen(preferred, '127.0.0.1')
    try {
      await listen(preferred, '::')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return listen(0, '127.0.0.1')
      if ((error as NodeJS.ErrnoException).code !== 'EAFNOSUPPORT') throw error
    }
    return port
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    return listen(0, '127.0.0.1')
  }
}

async function ready(url: string, check: (response: Response) => Promise<boolean>) {
  let last = '尚未收到响应'
  for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
      last = `HTTP ${response.status}`
      if (await check(response)) return
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
      // 服务启动期间连接暂时不可用
    }
    await new Promise((done) => setTimeout(done, 300))
  }
  if (!stopping) throw new Error(`就绪检查失败 ${url} ${last}`)
}

try {
  console.log(`本地运行 Node ${process.version}`)
  markOfflineRunning()
  const apiPort = await freePort(8787)
  const webPort = await freePort(8790)
  const apiUrl = `http://127.0.0.1:${apiPort}`
  const webUrl = `http://127.0.0.1:${webPort}`
  env.API_PORT = String(apiPort)
  env.OFFLINE_API_ORIGIN = apiUrl
  start('API', root, ['--import', 'tsx', 'apps/api/src/main.ts'])
  start('Web', webRoot, [nextCli, 'dev', '--turbopack', '-p', String(webPort), '-H', '127.0.0.1'], webEnv)
  await ready(`${apiUrl}/api/ready`, (response) => Promise.resolve(response.ok))
  await ready(`${webUrl}/api/health`, async (response) => {
    if (!response.ok) return false
    const health = (await response.json()) as { conversationMode?: string }
    return health.conversationMode === 'durable_refund_simulation'
  })
  if (!stopping) console.log(`本地离线工作台已就绪 ${webUrl}/workbench`)
} catch (error) {
  console.error(error)
  process.exitCode = 1
  stop()
}
