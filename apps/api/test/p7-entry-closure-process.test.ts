import { expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { openDatabase } from '@aftersales/persistence'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const evidence = join(
  root,
  'docs/experiments/p7-entry-closure-evidence',
  new Date().toISOString().replaceAll(':', '-'),
)
const headers = {
  Authorization: 'Bearer cust-token-1001',
  'Content-Type': 'application/json',
  'Idempotency-Key': 'start',
}

function launch(mode?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'p7-entry-closure-'))
  const dbPath = join(directory, 'application.db')
  const probePath = join(directory, 'probe.jsonl')
  // 仅传入运行所需系统字段及虚构模型凭据 不继承真实模型环境
  const env: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATH: process.env.PATH,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    API_PORT: '0',
    DB_PATH: dbPath,
    P7_ENTRY_PROBE_PATH: probePath,
    ANTHROPIC_API_KEY: 'offline-sentinel-not-a-credential',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    ...(mode ? { P6_BUSINESS_MODE: mode } : {}),
  }
  const child = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(join(root, 'apps/api/test/fixtures/p7-entry-guard.mjs')).href,
      '--import',
      'tsx',
      join(root, 'apps/api/src/main.ts'),
    ],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let log = ''
  child.stdout?.on('data', (data) => {
    log += String(data)
  })
  child.stderr?.on('data', (data) => {
    log += String(data)
  })
  const exited = new Promise<number | null>((done) => child.once('close', done))
  return { child, exited, dbPath, probePath, directory, log: () => log }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((done) => {
    child.once('close', () => done())
    child.kill()
  })
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 240; i++) {
    if (check()) return
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error('等待正式入口状态超时')
}
async function ready(process: ReturnType<typeof launch>) {
  await waitFor(
    () => /http:\/\/127\.0\.0\.1:\d+/.test(process.log()) || process.child.exitCode !== null,
  )
  const url = process.log().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
  if (!url) throw new Error(process.log())
  return url
}
function save(mode: string, process: ReturnType<typeof launch>, result: unknown) {
  mkdirSync(evidence, { recursive: true })
  writeFileSync(
    join(evidence, `${mode}.json`),
    JSON.stringify(
      {
        mode,
        directory: process.directory,
        probe: readFileSync(process.probePath, 'utf8'),
        log: process.log(),
        result,
      },
      null,
      2,
    ),
  )
}

it('测试探针同时拦截全局 fetch 与旧供应商底层 HTTP 请求', () => {
  const directory = mkdtempSync(join(tmpdir(), 'p7-probe-check-'))
  const probePath = join(directory, 'probe.jsonl')
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(join(root, 'apps/api/test/fixtures/p7-entry-guard.mjs')).href,
      '--input-type=module',
      '-e',
      "import http from 'node:http'; import https from 'node:https'; try { http.request('http://127.0.0.1:1') } catch {} try { https.get('https://127.0.0.1:1') } catch {} try { await fetch('http://127.0.0.1:1/v1/messages') } catch {}",
    ],
    { env: { SystemRoot: process.env.SystemRoot, P7_ENTRY_PROBE_PATH: probePath }, timeout: 5000 },
  )
  expect(child.status).toBe(0)
  expect(
    readFileSync(probePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  ).toEqual([{ kind: 'model-network' }, { kind: 'model-network' }, { kind: 'model-network' }])
})

it('实际 main 即使存在虚构供应商配置也关闭新建和旧运行恢复的真实模型调用', async () => {
  const process = launch()
  try {
    const url = await ready(process)
    const health = (await (await fetch(`${url}/api/health`)).json()) as { modelAvailable: boolean }
    expect(health.modelAvailable).toBe(false)
    expect(
      (
        await fetch(`${url}/api/runs`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ message: '查询订单' }),
        })
      ).status,
    ).toBe(503)
    const db = openDatabase(process.dbPath)
    try {
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO agent_runs(run_id,customer_id,status,prompt_version,model,created_at,updated_at,source) VALUES ('legacy-run','C1001','awaiting_input','legacy','legacy',?,?,'customer')",
      ).run(now, now)
      expect(
        (
          await fetch(`${url}/api/runs/legacy-run/messages`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ message: '继续查询' }),
          })
        ).status,
      ).toBe(200)
      await waitFor(
        () =>
          (
            db.prepare("SELECT status FROM agent_runs WHERE run_id = 'legacy-run'").get() as {
              status: string
            }
          ).status === 'failed',
      )
      db.prepare(
        "INSERT INTO agent_runs(run_id,customer_id,status,prompt_version,model,created_at,updated_at,source) VALUES ('legacy-recovery','C1001','running','legacy','legacy',?,?,'customer')",
      ).run(now, now)
      expect(
        (
          await fetch(`${url}/api/runs/legacy-recovery/resume`, {
            method: 'POST',
            headers: { ...headers, Authorization: 'Bearer operator-token' },
            body: '{}',
          })
        ).status,
      ).toBe(200)
      await waitFor(
        () =>
          (
            db.prepare("SELECT status FROM agent_runs WHERE run_id = 'legacy-recovery'").get() as {
              status: string
            }
          ).status === 'failed',
      )
      for (const runId of ['legacy-run', 'legacy-recovery']) {
        const failure = db
          .prepare("SELECT payload_json FROM agent_events WHERE run_id = ? AND type = 'run.failed'")
          .get(runId) as { payload_json: string }
        expect(JSON.parse(failure.payload_json).message).toBe('LIVE_DISABLED')
      }
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE type = 'run.completed'").get(),
      ).toEqual({ n: 0 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM p7_calls').get()).toEqual({ n: 0 })
      expect(readFileSync(process.probePath, 'utf8')).toBe('')
      save('disabled', process, {
        health,
        runs: db.prepare('SELECT run_id,status FROM agent_runs').all(),
        events: db.prepare('SELECT type,payload_json FROM agent_events').all(),
        modelCalls: 0,
      })
    } finally {
      db.close()
    }
  } finally {
    await stop(process.child)
  }
}, 30000)

it('实际 main 的 live 模式在数据库初始化前拒绝且不读取环境文件', async () => {
  const process = launch('live')
  try {
    expect(await process.exited).not.toBe(0)
    expect(process.log()).toContain('LIVE_DISABLED')
    expect(existsSync(process.dbPath)).toBe(false)
    expect(readFileSync(process.probePath, 'utf8')).toBe('')
    save('live-rejected', process, { databaseCreated: false, modelCalls: 0 })
  } finally {
    await stop(process.child)
  }
}, 30000)

it('实际 main 的 simulation 通过 P7 完成查询后保持咨询可继续', async () => {
  const process = launch('simulation')
  try {
    const url = await ready(process)
    const response = await fetch(`${url}/api/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: '查询 SO-2026-0003' }),
    })
    expect(response.status).toBe(202)
    const accepted = (await response.json()) as { runId: string }
    const db = openDatabase(process.dbPath)
    try {
      await waitFor(
        () =>
          (
            db.prepare('SELECT status FROM agent_runs WHERE run_id = ?').get(accepted.runId) as {
              status: string
            }
          ).status === 'awaiting_input',
      )
      const calls = db.prepare('SELECT purpose,status,actual FROM p7_calls').all()
      const pause = db
        .prepare(
          "SELECT payload_json FROM agent_events WHERE run_id = ? AND type = 'run.paused' ORDER BY sequence DESC LIMIT 1",
        )
        .get(accepted.runId) as { payload_json: string }
      expect(JSON.parse(pause.payload_json)).toMatchObject({ consultation: 'ready' })
      expect(calls).toEqual([
        { purpose: 'main_agent', status: 'settled', actual: 0 },
        { purpose: 'main_agent', status: 'settled', actual: 0 },
      ])
      expect(readFileSync(process.probePath, 'utf8')).toBe('')
      save('simulation', process, { accepted, calls, externalModelCalls: 0 })
    } finally {
      db.close()
    }
  } finally {
    await stop(process.child)
  }
}, 30000)
