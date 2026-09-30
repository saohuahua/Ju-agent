import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { openDatabase, initializeDemo } from '../../packages/persistence/src/index.js'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// 从已有持久化包解析数据库依赖 不新增根目录依赖
const persistenceRequire = createRequire(new URL('../../packages/persistence/package.json', import.meta.url))
const Database = persistenceRequire('better-sqlite3') as new (path: string, options: { readonly: boolean }) => ReturnType<typeof openDatabase>
const directory = mkdtempSync(join(tmpdir(), 'youju-p11-demo-'))
const original = join(directory, 'original')
const restored = join(directory, 'restored')
const backup = join(directory, 'backup')
mkdirSync(original, { recursive: true })
const customer = 'cust-token-1001'
const children: Array<{ process: ChildProcess; closed: Promise<number | null> }> = []
const steps: Array<{ step: string; result: unknown }> = []
const logs: string[] = []
let active: Awaited<ReturnType<typeof start>> | undefined

// 只继承运行工具链需要的环境 不读取模型凭据或环境文件
function environment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return {
    ...env,
    P6_BUSINESS_MODE: 'simulation',
    P6_EMBEDDED_SIMULATOR: '1',
    API_HOST: '127.0.0.1',
    API_PORT: '0',
    DB_PATH: join(root, 'business', 'app.db'),
    P6_CHANNEL_DB_PATH: join(root, 'channel', 'channel.db'),
    OPERATOR_TOKEN: 'operator-token',
    SUPERVISOR_TOKEN: 'supervisor-token',
  }
}

function record(step: string, result: unknown) {
  steps.push({ step, result })
  console.log(JSON.stringify({ step, result }))
}

function database(root: string, kind: 'business' | 'channel', readonly = true) {
  return new Database(join(root, kind, kind === 'business' ? 'app.db' : 'channel.db'), { readonly })
}

// 只修改本脚本新建的学习夹具 不预造审批任务或退款结果
const prepared = openDatabase(environment(original).DB_PATH!)
initializeDemo(prepared)
prepared.transaction(() => {
  for (const order of ['SO-2026-0001', 'SO-2026-0005']) {
    prepared.prepare("UPDATE orders SET customer_id='C1001',status='paid',total_amount_cents=29900,shipped_at=NULL,delivered_at=NULL WHERE order_no=?").run(order)
  }
  prepared.prepare("UPDATE orders SET customer_id='C1001',status='delivered',total_amount_cents=699900,delivered_at=? WHERE order_no='SO-2026-0003'").run(new Date().toISOString())
})()
prepared.close()

async function start(root: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', join(project, 'apps/api/src/main.ts')], {
    cwd: project,
    env: environment(root),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const closed = new Promise<number | null>((done) => child.once('close', done))
  children.push({ process: child, closed })
  let output = ''
  child.stdout!.on('data', (chunk) => { output += String(chunk); logs.push(String(chunk)) })
  child.stderr!.on('data', (chunk) => logs.push(String(chunk)))
  let failure: Error | undefined
  child.once('error', (error) => { failure = error })
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (failure) throw failure
    if (child.exitCode !== null) throw new Error(`演示进程提前退出 ${child.exitCode}`)
    const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
    if (url) {
      const ready = await fetch(`${url}/api/ready`, { signal: AbortSignal.timeout(2000) })
      if (ready.ok) return { child, closed, url, root }
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error('独立演示启动超时')
}

async function stop(server: Awaited<ReturnType<typeof start>>) {
  if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGTERM')
  await server.closed
}

// 响应类型只描述本次演示使用的字段 实际结果仍由断言核验
type AcceptedRun = { runId: string; taskId: string }
type RefundProgress = { progress: string; returnNo: string }

async function request<T = unknown>(path: string, body?: unknown, token = customer, key?: string, expected = 200): Promise<T> {
  assert(active)
  const response = await fetch(`${active.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  const data = await response.json()
  assert.equal(response.status, expected, `${path} ${JSON.stringify(data)}`)
  return data as T
}

async function progress(runId: string, state: string) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const value = (await request<{ progress: RefundProgress }>(`/api/runs/${runId}/customer-progress`)).progress
    if (value?.progress === state) return value
    if (value && ['failed', 'rejected', 'expired'].includes(value.progress)) throw new Error(`意外业务状态 ${JSON.stringify(value)}`)
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`等待 ${state} 超时`)
}

function channel(root: string) {
  const db = database(root, 'channel')
  try { return db.prepare('SELECT business_key,status,submissions,charges FROM p6_channel ORDER BY business_key').all() as Array<{ business_key: string; status: string; submissions: number; charges: number }> }
  finally { db.close() }
}

function dataTool(root: string, mode: string, target?: string) {
  return execFileSync(process.execPath, ['--import', 'tsx', join(project, 'scripts/p10-data.ts'), mode, ...(target ? [target] : [])], {
    cwd: project, env: environment(root), encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
}

console.log(`独立演示目录 ${directory}`)
try {
  active = await start(original)
  record('ready', { url: active.url, directory, node: process.version, mode: 'simulation' })
  const refundBody = { message: 'SO-2026-0001 未发货 我要退款' }
  const refund = await request<AcceptedRun>('/api/runs', refundBody, customer, 'p11-refund', 202)
  const replay = await request<AcceptedRun>('/api/runs', refundBody, customer, 'p11-refund', 202)
  assert.equal(refund.runId, replay.runId)
  assert.equal(refund.taskId, replay.taskId)
  const refundProgress = await progress(refund.runId, 'succeeded')
  await request(`/api/runs/${refund.runId}/customer-progress`, undefined, 'cust-token-1002', undefined, 403)
  record('refund-and-replay', { runId: refund.runId, returnNo: refundProgress.returnNo, channel: channel(original) })

  const returned = await request<AcceptedRun>('/api/runs', { message: 'SO-2026-0003 质量问题 我要退货退款' }, customer, 'p11-return', 202)
  await progress(returned.runId, 'awaiting_approval')
  const approvals = (await request<{ approvals: Array<{ runId: string; approvalId: string }> }>('/api/approvals', undefined, 'supervisor-token')).approvals
  const approval = approvals.find((item) => item.runId === returned.runId)
  assert(approval)
  await request(`/api/runs/${returned.runId}/approvals/${approval.approvalId}/decide`, { decision: 'approved', decidedBy: 'supervisor' }, 'supervisor-token', undefined, 202)
  const waiting = await progress(returned.runId, 'awaiting_shipment')
  assert(!channel(original).some((item) => item.business_key === `refund:${waiting.returnNo}`))
  record('approval-and-wait', { runId: returned.runId, returnNo: waiting.returnNo, channelBeforeReceipt: 0 })
  await stop(active)
  active = await start(original)
  await progress(returned.runId, 'awaiting_shipment')
  const shipment = { message: '已经寄回', returnShipment: { returnNo: waiting.returnNo, trackingNo: 'P11-LOCAL-RETURN' } }
  await request(`/api/runs/${returned.runId}/messages`, shipment, customer, 'p11-shipment', 202)
  await request(`/api/runs/${returned.runId}/messages`, shipment, customer, 'p11-shipment', 202)
  await progress(returned.runId, 'awaiting_receipt')
  assert(!channel(original).some((item) => item.business_key === `refund:${waiting.returnNo}`))
  await request('/api/operations/receive-goods', { returnNo: waiting.returnNo }, 'operator-token', undefined, 202)
  await progress(returned.runId, 'succeeded')
  record('restart-and-receipt', { progress: await progress(returned.runId, 'succeeded'), channel: channel(original) })

  // 故障只注入本次独立模拟渠道 不直接改变业务结果
  dataTool(original, 'unknown-fund')
  const unknown = await request<AcceptedRun>('/api/runs', { message: 'SO-2026-0005 未发货 我要退款' }, customer, 'p11-unknown', 202)
  const unknownProgress = await progress(unknown.runId, 'unknown')
  record('unknown-preserved', unknownProgress)
  const channelBefore = channel(original)
  assert.equal(channelBefore.length, 3)
  for (const item of channelBefore) {
    assert.equal(item.submissions, 1)
    assert.equal(item.charges, item.status === 'succeeded' ? 1 : 0)
  }
  for (const runId of [refund.runId, returned.runId]) {
    const events = (await request<{ events: Array<{ type: string }> }>(`/api/runs/${runId}/events/json`)).events
    assert.equal(events.filter((event) => event.type === 'run.completed').length, 1)
  }
  await stop(active)
  active = undefined
  const before = JSON.parse(dataTool(original, 'snapshot'))
  dataTool(original, 'backup', backup)
  dataTool(restored, 'restore', backup)
  const restoredSnapshot = JSON.parse(dataTool(restored, 'snapshot'))
  assert.deepEqual(restoredSnapshot, before)
  active = await start(restored)
  await progress(refund.runId, 'succeeded')
  await progress(returned.runId, 'succeeded')
  await progress(unknown.runId, 'unknown')
  assert.deepEqual(channel(restored), channelBefore)
  record('backup-restore', { unchanged: true, original, restored, backup, channel: channelBefore })
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ status: 'passed', date: new Date().toISOString(), mode: 'simulation', node: process.version, steps, sourceHashes: Object.fromEntries(['docs/runbooks/p11-demo.ts', 'apps/api/src/main.ts', 'packages/runtime/src/conversation-demo.ts'].map((file) => [file, createHash('sha256').update(readFileSync(join(project, file))).digest('hex')])) }, null, 2))
  console.log(`演示通过 ${join(directory, 'summary.json')}`)
} catch (error) {
  writeFileSync(join(directory, 'failure.json'), JSON.stringify({ status: 'failed', steps, error: error instanceof Error ? error.message : String(error) }, null, 2))
  throw error
} finally {
  if (active) await stop(active)
  for (const item of children) {
    if (item.process.exitCode === null && item.process.signalCode === null) item.process.kill('SIGTERM')
    await item.closed
  }
  writeFileSync(join(directory, 'process.log'), logs.join(''))
}
