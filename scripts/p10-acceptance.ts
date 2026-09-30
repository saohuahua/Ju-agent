import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'

const local = process.argv.includes('--local')
const root = process.cwd()
const stamp = new Date().toISOString().replaceAll(':', '-')
const evidence = resolve('artifacts/p10', stamp)
mkdirSync(evidence, { recursive: true })
const directory = mkdtempSync(join(tmpdir(), 'youju-p10-'))
const project = `p10-accept-${Date.now()}`
// 子进程环境只传运行必需项 不继承模型凭据或 Docker 远程配置
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
    'P10_BROWSER_EXECUTABLE',
  ].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
)
Object.assign(env, {
  P6_BUSINESS_MODE: 'simulation',
  P6_EMBEDDED_SIMULATOR: '1',
  API_HOST: '127.0.0.1',
  DB_PATH: join(directory, 'business/app.db'),
  P6_CHANNEL_DB_PATH: join(directory, 'channel/channel.db'),
  P10_API_PORT: '28787',
  P10_WEB_PORT: '28790',
  COMPOSE_DISABLE_ENV_FILE: 'true',
})
const composeArgs = [
  'compose',
  '--project-name',
  project,
  '--env-file',
  join(root, 'infra/docker/offline.env'),
  '-f',
  join(root, 'compose.yaml'),
]
const logs: string[] = []
let child: ChildProcess | undefined
let dockerVerified = false
let base = 'http://127.0.0.1:28790'

async function command(executable: string, args: string[]): Promise<string> {
  return new Promise((done, reject) => {
    const proc = spawn(executable, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    proc.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    proc.stderr.on('data', (chunk) => {
      output += String(chunk)
    })
    proc.once('error', reject)
    proc.once('close', (code) => {
      logs.push(`${executable} ${args.join(' ')}\n${output}`)
      if (code === 0) done(output)
      else reject(new Error(`命令失败 ${code} ${output}`))
    })
  })
}
const compose = (...args: string[]) => command('docker', [...composeArgs, ...args])
const data = (mode: string) =>
  local
    ? command(process.execPath, ['--import', 'tsx', 'scripts/p10-data.ts', mode])
    : compose('exec', '-T', 'api', 'node', '--import', 'tsx', 'scripts/p10-data.ts', mode)

async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  for (let count = 0; count < 180; count++) {
    const value = await read()
    if (accepts(value)) return value
    await new Promise((done) => setTimeout(done, 150))
  }
  throw new Error('等待业务状态超时')
}
async function start() {
  if (!local) {
    await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '90')
    return
  }
  const port = await new Promise<number>((done) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const value = (server.address() as { port: number }).port
      server.close(() => done(value))
    })
  })
  env.API_PORT = String(port)
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/main.ts'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout?.on('data', (value) => logs.push(String(value)))
  child.stderr?.on('data', (value) => logs.push(String(value)))
  await until(
    async () =>
      fetch(`${base}/api/ready`)
        .then((r) => r.status)
        .catch(() => 0),
    (status) => status === 200,
  )
}
async function stop(force = false) {
  if (!local) {
    if (force) await compose('kill', '-s', 'SIGKILL', 'api')
    else {
      await compose('stop')
      const id = (await compose('ps', '--all', '-q', 'api')).trim()
      assert.ok(id)
      assert.equal(
        (await command('docker', ['inspect', '--format', '{{.State.ExitCode}}', id])).trim(),
        '0',
      )
      assert.match(await compose('logs', '--no-color', 'api'), /监听 SSE Worker 与数据库已关闭/)
    }
    return
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    const current = child
    await new Promise<void>((done) => {
      current.once('close', () => done())
      current.kill(force ? 'SIGKILL' : 'SIGTERM')
    })
  }
}
const headers = (key: string, token = 'cust-token-1001') => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'Idempotency-Key': key,
})
async function post(path: string, body: unknown, key: string, status = 202, token?: string) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: headers(key, token),
    body: JSON.stringify(body),
  })
  assert.equal(response.status, status, `${path} ${await response.clone().text()}`)
  return response.json() as Promise<{ runId: string }>
}
async function progress(runId: string) {
  const response = await fetch(`${base}/api/runs/${runId}/customer-progress`, {
    headers: headers('read'),
  })
  assert.equal(response.status, 200)
  return ((await response.json()) as { progress: { progress: string; returnNo: string } | null })
    .progress
}
// 读取原库证据 不以 HTTP 成功替代业务与渠道断言
type Snapshot = {
  orders: unknown[]
  runs: unknown[]
  tasks: unknown[]
  links: { run_id: string; tool_call_id: string; return_no: string; projected: number }[]
  refunds: { return_no: string; status: string }[]
  events: { run_id: string; type: string; payload_json: string }[]
  calls: { call_id: string; status: string; reserved: number; actual: number | null }[]
  totals: { committed: number; active: number }
  channel: { business_key: string; status: string; submissions: number; charges: number }[]
}
const snapshot = async () => JSON.parse(await data('snapshot')) as Snapshot
const result: Record<string, unknown> = {
  mode: local ? 'local-main-process' : 'docker',
  project,
  directory,
  evidence,
}

try {
  if (!local) {
    const context = execFileSync('docker', ['context', 'inspect'], { env, encoding: 'utf8' })
    const host =
      (JSON.parse(context) as { Endpoints: { docker: { Host: string } } }[])[0]?.Endpoints.docker
        .Host ?? ''
    assert.match(host, /^(npipe:|unix:)/, '仅允许本机 Docker daemon')
    dockerVerified = true
    await compose('config', '--quiet')
    await command('docker', ['info'])
  }
  await start()
  await data('prepare')
  if (!local) assert.equal((await fetch(`${base}/workbench`)).status, 200)
  const request = { message: 'SO-2026-0001 未发货 我要退款' }
  const refund = await post('/api/runs', request, 'p10-refund')
  assert.deepEqual(await post('/api/runs', request, 'p10-refund'), refund)
  await until(
    () => progress(refund.runId),
    (p) => p?.progress === 'succeeded',
  )
  const returning = await post(
    '/api/runs',
    { message: 'SO-2026-0003 质量问题 我要退货退款' },
    'p10-return',
  )
  const waiting = await until(
    () => progress(returning.runId),
    (p) => p?.progress === 'awaiting_shipment',
  )
  const before = await snapshot()
  assert.equal(before.channel.length, 1)
  assert.equal(before.channel[0]?.charges, 1)
  const stream = await fetch(`${base}/api/runs/${returning.runId}/events?token=cust-token-1001`)
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/)
  const reader = stream.body!.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /connected|event:/)
  await reader.cancel()
  // 强退本次独立服务 不改租约 不触碰已有演示进程
  await stop(true)
  if (!local) await compose('rm', '-f', 'api', 'web')
  await start()
  assert.equal((await progress(returning.runId))?.returnNo, waiting!.returnNo)
  assert.deepEqual((await snapshot()).calls, before.calls)
  const shipment = {
    message: '已寄回商品',
    returnShipment: { returnNo: waiting!.returnNo, trackingNo: 'P10-LOCAL-RETURN' },
  }
  await post(`/api/runs/${returning.runId}/messages`, shipment, 'p10-shipment')
  await post(`/api/runs/${returning.runId}/messages`, shipment, 'p10-shipment')
  assert.equal((await snapshot()).channel.length, 1)
  await post(
    '/api/operations/receive-goods',
    { returnNo: waiting!.returnNo },
    'p10-receive',
    202,
    'supervisor-token',
  )
  await until(
    () => progress(returning.runId),
    (p) => p?.progress === 'succeeded',
  )
  const human = await post('/api/runs', { message: '我要补偿 请人工处理' }, 'p10-human')
  await until(
    async () => {
      const response = await fetch(`${base}/api/runs/${human.runId}`, { headers: headers('read') })
      return ((await response.json()) as { run: { status: string } }).run.status
    },
    (status) => status === 'escalated',
  )
  await post(`/api/runs/${human.runId}/handover`, {}, 'takeover', 200, 'operator-token')
  await post(`/api/runs/${human.runId}/messages`, shipment, 'blocked-shipment', 409)
  await post(`/api/runs/${human.runId}/messages`, { message: '请人工核验' }, 'human-message', 200)
  assert.equal(
    (
      await fetch(`${base}/api/runs/${human.runId}/customer-progress`, {
        headers: headers('isolation', 'cust-token-1002'),
      })
    ).status,
    403,
  )
  await data('unknown-fund')
  const unknown = await post(
    '/api/runs',
    { message: 'SO-2026-0006 质量问题 我要退货退款' },
    'p10-unknown',
  )
  const unknownWaiting = await until(
    () => progress(unknown.runId),
    (p) => p?.progress === 'awaiting_shipment',
  )
  await post(
    `/api/runs/${unknown.runId}/messages`,
    {
      ...shipment,
      returnShipment: { ...shipment.returnShipment, returnNo: unknownWaiting!.returnNo },
    },
    'unknown-shipment',
  )
  await post(
    '/api/operations/receive-goods',
    { returnNo: unknownWaiting!.returnNo },
    'unknown-receive',
    202,
    'supervisor-token',
  )
  await until(
    () => progress(unknown.runId),
    (p) => p?.progress === 'unknown',
  )
  await data('unknown-fee')
  const retained = await snapshot()
  // 非终态会话保持 SSE 连接 验证停止不会被长连接无限阻塞
  const shutdownStream = await fetch(`${base}/api/runs/${human.runId}/events?token=cust-token-1001`)
  const shutdownReader = shutdownStream.body!.getReader()
  await shutdownReader.read()
  await stop()
  await shutdownReader.cancel().catch(() => undefined)
  await start()
  const final = await snapshot()
  assert.deepEqual(final.calls, retained.calls)
  assert.deepEqual(final.channel, retained.channel)
  assert.deepEqual(final.orders, retained.orders)
  assert.equal(final.totals.active, 1)
  assert.equal(final.totals.committed, 1234)
  assert.equal((await progress(unknown.runId))?.progress, 'unknown')
  for (const run of [refund, returning]) {
    const link = final.links.find((item) => item.run_id === run.runId)!
    assert.equal(link.projected, 1)
    assert.equal(
      final.refunds.find((item) => item.return_no === link.return_no)?.status,
      'succeeded',
    )
    assert.equal(
      final.events.filter((e) => e.run_id === run.runId && e.type === 'run.completed').length,
      1,
    )
    const tools = final.events
      .filter((e) => e.run_id === run.runId && e.type === 'agent.tool_results')
      .flatMap(
        (e) =>
          (JSON.parse(e.payload_json) as { results: { toolCallId: string; content: string }[] })
            .results,
      )
    const original = tools.filter((tool) => tool.toolCallId === link.tool_call_id)
    assert.equal(original.length, 1)
    assert.equal(JSON.parse(original[0]!.content).refundStatus, 'succeeded')
    const channel = final.channel.find((item) => item.business_key === `refund:${link.return_no}`)!
    assert.equal(channel.submissions, 1)
    assert.equal(channel.charges, 1)
  }
  // 停写后生成一致备份 再恢复到新的独立目录或卷
  await stop()
  const backup = join(evidence, 'backup')
  mkdirSync(backup)
  if (local) {
    await command(process.execPath, ['--import', 'tsx', 'scripts/p10-data.ts', 'backup', backup])
    env.DB_PATH = join(directory, 'restored-business/app.db')
    env.P6_CHANNEL_DB_PATH = join(directory, 'restored-channel/channel.db')
    await command(process.execPath, ['--import', 'tsx', 'scripts/p10-data.ts', 'restore', backup])
  } else {
    const mount = `${backup.replaceAll('\\', '/')}:/backup`
    await compose(
      'run',
      '--rm',
      '--no-deps',
      '-v',
      mount,
      'api',
      'node',
      '--import',
      'tsx',
      'scripts/p10-data.ts',
      'backup',
    )
    composeArgs[2] = `${project}-restore`
    await compose(
      'run',
      '--rm',
      '--no-deps',
      '-v',
      mount,
      'api',
      'node',
      '--import',
      'tsx',
      'scripts/p10-data.ts',
      'restore',
    )
  }
  await start()
  await data('integrity')
  assert.deepEqual(await snapshot(), final)
  // live 拒绝必须发生在新入口写库之前
  if (local) {
    const previous = env.P6_BUSINESS_MODE
    env.P6_BUSINESS_MODE = 'live'
    await assert.rejects(
      command(process.execPath, ['--import', 'tsx', 'apps/api/src/main.ts']),
      /LIVE_DISABLED/,
    )
    env.P6_BUSINESS_MODE = previous
  } else {
    await assert.rejects(
      compose(
        'exec',
        '-T',
        '-e',
        'P6_BUSINESS_MODE=live',
        'api',
        'node',
        '--import',
        'tsx',
        'apps/api/src/main.ts',
      ),
      /LIVE_DISABLED/,
    )
  }
  Object.assign(result, {
    status: 'passed',
    beforeCrash: before,
    final,
    runIds: { refund, returning, human, unknown },
  })
  // 正式评测入口必须在部署中可用 并保留原未知费用占位
  const evalResponse = await fetch(`${base}/api/eval/run`, {
    method: 'POST',
    headers: headers('p10-eval', 'operator-token'),
  })
  assert.equal(evalResponse.status, 200)
  const evaluation = (await evalResponse.json()) as {
    reportId: string
    total: number
    passed: number
    gatePassed: boolean
  }
  assert.equal(evaluation.total, 124)
  assert.equal(evaluation.passed, 124)
  assert.equal(evaluation.gatePassed, true)
  const evidenceResponse = await fetch(`${base}/api/eval/reports/${evaluation.reportId}/evidence`, {
    headers: headers('p10-eval-read', 'operator-token'),
  })
  assert.equal(evidenceResponse.status, 200)
  const evalEvidence = (await evidenceResponse.json()) as {
    evidence: {
      metadata: {
        source: { head: string | null; dirty: boolean | null; hash: string; completeness: string }
      }
    }
  }
  const source = evalEvidence.evidence.metadata.source
  assert.match(source.hash, /^[a-f0-9]{64}$/)
  if (!local) {
    assert.equal(source.head, null)
    assert.equal(source.dirty, null)
    assert.equal(source.completeness, 'verified-deployment-content-manifest')
  }
  const afterEval = await snapshot()
  assert.deepEqual(afterEval.channel, final.channel)
  assert.equal(afterEval.totals.active, 1)
  assert.equal(afterEval.totals.committed, final.totals.committed + 3390)
  result.evaluation = { ...evaluation, source, totals: afterEval.totals }
  if (!local) {
    await command(process.execPath, ['--import', 'tsx', 'scripts/p10-browser.ts', base, evidence])
    result.browser = 'passed'
  }
} catch (error) {
  result.status = 'failed'
  result.error = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
} finally {
  if (local) await stop()
  else if (dockerVerified) {
    await compose('logs', '--no-color').catch((error) => logs.push(String(error)))
    await compose('stop').catch((error) => logs.push(String(error)))
  }
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify(result, null, 2))
  writeFileSync(join(evidence, 'process.log'), logs.join('\n'))
  console.log(
    JSON.stringify({ status: result.status, error: result.error, evidence, project, directory }),
  )
}
