import { afterAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../../persistence/src/db.js'
import { P6TaskRepository } from '../../persistence/src/p6-task-repository.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const entry = join(root, 'packages/runtime/test/fixtures/p6-process.ts')
const evidenceRoot = join(
  root,
  'docs/experiments/p6-results',
  new Date().toISOString().replaceAll(':', '-'),
)
mkdirSync(evidenceRoot, { recursive: true })
const summaries: unknown[] = []
const sourceFiles = [
  'packages/contracts/src/p6-durable.ts',
  'packages/persistence/src/p6-migration.ts',
  'packages/persistence/src/p6-task-repository.ts',
  'packages/persistence/src/p6-business-adapter.ts',
  'packages/persistence/src/p6-payment-simulator.ts',
  'packages/runtime/src/p6-worker.ts',
  'packages/runtime/test/fixtures/p6-process.ts',
  'packages/runtime/test/p6-process.test.ts',
]
const sourceHashes = Object.fromEntries(
  sourceFiles.map((file) => [
    file,
    createHash('sha256')
      .update(readFileSync(join(root, file)))
      .digest('hex'),
  ]),
)

interface Message {
  event: string
  detail: unknown
}
interface ProcessHandle {
  child: ChildProcess
  messages: Message[]
  exited: Promise<number | null>
  wait(event: string): Promise<Message>
}

/** 每个角色都是独立 Node 进程 日志完整保存 不将异常重试冒充进程恢复 */
function launch(args: string[], logs: string[]): ProcessHandle {
  const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const messages: Message[] = []
  child.on('message', (message) => messages.push(message as Message))
  child.stdout?.on('data', (data) => logs.push(String(data)))
  child.stderr?.on('data', (data) => logs.push(String(data)))
  const exited = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', resolveExit)
  })
  return {
    child,
    messages,
    exited,
    wait: async (event) => {
      const end = Date.now() + 15_000
      while (Date.now() < end) {
        const match = messages.find((message) => message.event === event)
        if (match) return match
        if (child.exitCode !== null)
          throw new Error(`子进程提前退出 ${child.exitCode} ${logs.join('')}`)
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
      throw new Error(`子进程事件等待超时 ${event}`)
    },
  }
}

async function scenario(
  name: string,
  work: (ctx: {
    appPath: string
    channelPath: string
    url: string
    logs: string[]
    run(mode: string, fault?: string): ProcessHandle
    stopChannel(): Promise<void>
  }) => Promise<void>,
) {
  const directory = join(evidenceRoot, name)
  mkdirSync(directory, { recursive: true })
  const appPath = join(directory, 'application.db')
  const channelPath = join(directory, 'channel.db')
  const logs: string[] = []
  const children: ProcessHandle[] = []
  const channel = launch(['channel', channelPath], logs)
  children.push(channel)
  let passed = false
  try {
    const ready = await channel.wait('ready')
    const { url } = ready.detail as { url: string }
    await work({
      appPath,
      channelPath,
      url,
      logs,
      stopChannel: async () => {
        channel.child.kill()
        await channel.exited
      },
      run: (mode, fault = 'normal') => {
        const child = launch([mode, appPath, fault, url], logs)
        children.push(child)
        return child
      },
    })
    passed = true
  } finally {
    for (const proc of children)
      if (proc.child.exitCode === null && !proc.child.killed) proc.child.kill()
    await Promise.all(children.map((proc) => proc.exited))
    const app = openDatabase(appPath)
    const external = openDatabase(channelPath)
    const tables = [
      'p6_tasks',
      'p6_commands',
      'p6_steps',
      'p6_effects',
      'p6_events',
      'compensations',
      'approval_execution_intents',
      'idempotency_records',
    ]
    const snapshot: Record<string, unknown> = {}
    for (const table of tables) {
      if (
        app.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      ) {
        snapshot[table] = app.prepare(`SELECT * FROM ${table}`).all()
      }
    }
    snapshot.channel = external.prepare('SELECT * FROM p6_channel').all()
    snapshot.channelQueries = external.prepare('SELECT * FROM p6_channel_queries').all()
    app.pragma('wal_checkpoint(TRUNCATE)')
    external.pragma('wal_checkpoint(TRUNCATE)')
    app.close()
    external.close()
    writeFileSync(join(directory, 'process.log'), logs.join(''))
    writeFileSync(
      join(directory, 'terminal-state.json'),
      JSON.stringify({ passed, ...snapshot }, null, 2),
    )
    summaries.push({
      name,
      passed,
      directory,
      processExits: await Promise.all(children.map((proc) => proc.exited)),
    })
  }
}

function state(path: string) {
  const db = openDatabase(path)
  try {
    return {
      task: db
        .prepare(
          'SELECT task_id AS id, status, generation, lease_until AS leaseUntil FROM p6_tasks',
        )
        .get() as { id: string; status: string; generation: number; leaseUntil: number },
      business: db.prepare('SELECT status FROM compensations').get() as { status: string },
      steps: db.prepare('SELECT step FROM p6_steps').all() as { step: string }[],
    }
  } finally {
    db.close()
  }
}

async function expire(path: string) {
  const wait = Math.max(0, state(path).task.leaseUntil - Date.now() + 25)
  await new Promise((resolveWait) => setTimeout(resolveWait, wait))
}

function assertOneCharge(path: string) {
  const db = openDatabase(path)
  try {
    expect(
      db
        .prepare('SELECT SUM(charges) AS charges, SUM(submissions) AS submissions FROM p6_channel')
        .get(),
    ).toEqual({ charges: 1, submissions: 1 })
  } finally {
    db.close()
  }
}

afterAll(() => {
  writeFileSync(
    join(evidenceRoot, 'manifest.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        sourceHashes,
        realPaymentCalls: 0,
        paidModelCalls: 0,
        scope: 'P6 独立组合根进程实验 非正式 API 全链路验收',
        scenarios: summaries,
      },
      null,
      2,
    ),
  )
  console.log(`P6 进程证据 ${evidenceRoot}`)
})

describe('P6 真实子进程与独立持久渠道', () => {
  it.each([
    'accepted-before-worker',
    'before-model',
    'mid-stream',
    'after-model-checkpoint',
    'after-payment-response',
    'after-payment-checkpoint',
  ])(
    '%s 退出后续跑',
    async (fault) => {
      await scenario(fault, async ({ appPath, channelPath, run, logs }) => {
        expect(await run('accept').exited).toBe(73)
        if (fault !== 'accepted-before-worker') {
          expect(await run('worker', fault).exited).toBe(73)
          if (fault === 'mid-stream') expect(state(appPath).steps).toEqual([])
          await expire(appPath)
        }
        expect(await run('worker').exited).toBe(0)
        expect(state(appPath).task.status).toBe('completed')
        expect(state(appPath).business.status).toBe('succeeded')
        assertOneCharge(channelPath)
        const modelCalls = logs.join('').split('"event":"model-called"').length - 1
        expect(modelCalls).toBe(fault === 'mid-stream' ? 2 : 1)
        expect(logs.join('')).toContain('scripted-frozen-v1')
      })
    },
    30_000,
  )

  it('审批受理进程退出后由持久意图入队并消费原授权', async () => {
    await scenario('approval-accepted-exit', async ({ appPath, channelPath, run }) => {
      expect(await run('approval').exited).toBe(73)
      const before = openDatabase(appPath)
      expect(before.prepare('SELECT COUNT(*) AS n FROM p6_tasks').get()).toEqual({ n: 0 })
      expect(before.prepare('SELECT status FROM approval_execution_intents').get()).toEqual({
        status: 'pending',
      })
      before.close()
      expect(await run('worker').exited).toBe(0)
      expect(state(appPath).task.status).toBe('completed')
      const after = openDatabase(appPath)
      expect(after.prepare('SELECT status FROM approval_execution_intents').get()).toEqual({
        status: 'completed',
      })
      expect(after.prepare('SELECT one_time_token AS token FROM approval_requests').get()).toEqual({
        token: '',
      })
      after.close()
      assertOneCharge(channelPath)
    })
  }, 30_000)

  it.each(['response_lost', 'rejected', 'unknown', 'delayed'])(
    '独立渠道 %s 保留正确业务语义',
    async (fault) => {
      await scenario(`channel-${fault}`, async ({ appPath, channelPath, run }) => {
        const channel = openDatabase(channelPath)
        channel
          .prepare('INSERT INTO p6_channel_faults VALUES (?,?)')
          .run('compensation:CP-P6', fault)
        channel.close()
        expect(await run('accept').exited).toBe(73)
        expect(await run('worker').exited).toBe(0)
        const expected =
          fault === 'rejected'
            ? 'business_failed'
            : fault === 'unknown'
              ? 'needs_confirmation'
              : 'completed'
        expect(state(appPath).task.status).toBe(expected)
        if (fault === 'unknown') {
          const db = openDatabase(appPath)
          new P6TaskRepository(db).reconcile(state(appPath).task.id)
          db.close()
          expect(await run('worker').exited).toBe(0)
          expect(state(appPath).task.status).toBe('needs_confirmation')
          const verify = openDatabase(channelPath)
          expect(verify.prepare('SELECT submissions, charges FROM p6_channel').get()).toEqual({
            submissions: 1,
            charges: 0,
          })
          verify.close()
        } else if (fault !== 'rejected') assertOneCharge(channelPath)
        else expect(state(appPath).business.status).toBe('failed')
      })
    },
    30_000,
  )

  it('发送意图后退出且渠道无记录时保持未知 不猜测未发生', async () => {
    await scenario('intent-before-send-exit', async ({ appPath, channelPath, run }) => {
      expect(await run('accept').exited).toBe(73)
      expect(await run('worker', 'after-payment-intent').exited).toBe(73)
      await expire(appPath)
      expect(await run('worker').exited).toBe(0)
      expect(state(appPath).task.status).toBe('needs_confirmation')
      const channel = openDatabase(channelPath)
      expect(channel.prepare('SELECT COUNT(*) AS n FROM p6_channel').get()).toEqual({ n: 0 })
      channel.close()
    })
  }, 30_000)

  it('两个同时启动的 Worker 只有一个认领并产生副作用', async () => {
    await scenario('two-workers', async ({ appPath, channelPath, run }) => {
      await run('accept').exited
      const a = run('worker', 'competition')
      const b = run('worker', 'competition')
      await Promise.all([a.wait('worker-ready'), b.wait('worker-ready')])
      a.child.send('start')
      b.child.send('start')
      expect(await Promise.all([a.exited, b.exited])).toEqual([0, 0])
      const results = [a, b].flatMap((proc) =>
        proc.messages.filter((m) => m.event === 'worker-result'),
      )
      expect(results.filter((m) => (m.detail as { claimed: boolean }).claimed)).toHaveLength(1)
      expect(state(appPath).task.generation).toBe(1)
      assertOneCharge(channelPath)
    })
  }, 30_000)

  it('旧进程代次返回时无法覆盖新进程终态', async () => {
    await scenario('stale-worker-return', async ({ appPath, channelPath, run }) => {
      await run('accept').exited
      const old = run('stale')
      await old.wait('old-claimed')
      await expire(appPath)
      expect(await run('worker').exited).toBe(0)
      old.child.send('return')
      const returned = await old.wait('old-returned')
      expect(returned.detail).toEqual({ rejected: true, renewed: false })
      expect(await old.exited).toBe(0)
      expect(state(appPath).task.generation).toBe(2)
      expect(state(appPath).steps.map((s) => s.step)).not.toContain('stale-write')
      assertOneCharge(channelPath)
    })
  }, 30_000)

  it('只读超时跨进程重试有界且不重复已确认模型步骤', async () => {
    await scenario('read-timeout', async ({ appPath, channelPath, run, logs }) => {
      await run('accept').exited
      expect(await run('worker', 'read-timeout').exited).toBe(0)
      expect(state(appPath).task.status).toBe('queued')
      expect(await run('worker', 'read-timeout').exited).toBe(0)
      expect(state(appPath).task.status).toBe('call_failed')
      expect(logs.join('').split('"event":"model-called"').length - 1).toBe(1)
      const channel = openDatabase(channelPath)
      expect(channel.prepare('SELECT COUNT(*) AS n FROM p6_channel').get()).toEqual({ n: 0 })
      channel.close()
    })
  }, 30_000)

  it('资金成功后取消只停止后续工作 不隐瞒已确认资金事实', async () => {
    await scenario('cancel-after-send', async ({ appPath, channelPath, run }) => {
      await run('accept').exited
      expect(await run('worker', 'cancel-after-send').exited).toBe(0)
      expect(state(appPath).task.status).toBe('cancelled')
      expect(state(appPath).business.status).toBe('succeeded')
      assertOneCharge(channelPath)
    })
  }, 30_000)

  it('取消运行中的长只读任务会传播信号并停止资金发送', async () => {
    await scenario('cancel-long-task', async ({ appPath, channelPath, run }) => {
      await run('accept').exited
      const worker = run('worker', 'long-read')
      await worker.wait('read-called')
      const db = openDatabase(appPath)
      expect(new P6TaskRepository(db).cancel(state(appPath).task.id, 'C1001')).toBe(true)
      db.close()
      expect(await worker.exited).toBe(0)
      expect(state(appPath).task.status).toBe('cancelled')
      const channel = openDatabase(channelPath)
      expect(channel.prepare('SELECT COUNT(*) AS n FROM p6_channel').get()).toEqual({ n: 0 })
      channel.close()
    })
  }, 30_000)

  it('独立渠道自身重启后保留原交易 跨新运行编号也不重复资金动作', async () => {
    await scenario(
      'channel-restart-new-run',
      async ({ appPath, channelPath, run, logs, stopChannel }) => {
        await run('accept').exited
        expect(await run('worker').exited).toBe(0)
        await stopChannel()
        // 原渠道进程已退出 新服务只通过磁盘库恢复交易记录
        const restarted = launch(['channel', channelPath], logs)
        try {
          const ready = await restarted.wait('ready')
          const { url } = ready.detail as { url: string }
          const result = await fetch(`${url}/payments?key=compensation%3ACP-P6`)
          expect(((await result.json()) as { status: string }).status).toBe('succeeded')
          expect(await run('accept', 'new-run').exited).toBe(73)
          const next = launch(['worker', appPath, 'normal', url], logs)
          expect(await next.exited).toBe(0)
          const db = openDatabase(appPath)
          expect(
            db.prepare('SELECT COUNT(*) AS n FROM p6_tasks WHERE status = ?').get('completed'),
          ).toEqual({ n: 2 })
          expect(db.prepare('SELECT COUNT(DISTINCT run_id) AS n FROM p6_tasks').get()).toEqual({
            n: 2,
          })
          expect(db.prepare('SELECT COUNT(*) AS n FROM idempotency_records').get()).toEqual({
            n: 1,
          })
          db.close()
          assertOneCharge(channelPath)
        } finally {
          restarted.child.kill()
          await restarted.exited
        }
      },
    )
  }, 30_000)
})
