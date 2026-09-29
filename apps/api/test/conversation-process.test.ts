import { describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '@aftersales/persistence'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const evidence = join(
  root,
  'docs/experiments/conversation-results',
  new Date().toISOString().replaceAll(':', '-'),
)
const headers = (key = 'start') => ({
  Authorization: 'Bearer cust-token-1001',
  'Content-Type': 'application/json',
  'Idempotency-Key': key,
})

/** 通过真实 HTTP 受理和独立 Node 重启复核 不调用测试专用受理替身 */
async function launch(path: string, mode: string) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(root, 'apps/api/test/fixtures/conversation-process.ts'), path, mode],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  )
  let output = ''
  child.stdout?.on('data', (data) => {
    output += String(data)
  })
  child.stderr?.on('data', (data) => {
    output += String(data)
  })
  const exited = new Promise<number | null>((resolveExit) => child.once('close', resolveExit))
  const url = await new Promise<string>((resolveReady, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`API 启动超时 ${output}`))
    }, 15000)
    child.once('message', (message) => {
      clearTimeout(timer)
      resolveReady((message as { url: string }).url)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`API 退出 ${code} ${output}`))
    })
  })
  return { child, url, exited, output: () => output }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveStop) => {
    child.once('close', () => resolveStop())
    child.kill()
  })
}
async function waitState(url: string, runId: string, status: string) {
  for (let index = 0; index < 100; index++) {
    const body = (await (
      await fetch(`${url}/api/runs/${runId}`, { headers: headers() })
    ).json()) as { run: { status: string } }
    if (body.run.status === status) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error(`未到达 ${status}`)
}

describe('正式普通会话跨进程恢复', () => {
  it.each([
    'accepted',
    'after-model-response',
    'after-turn-checkpoint',
    'after-read-response',
    'after-read-checkpoint',
  ])(
    '%s 边界退出后不重复已确认消息和工具结果',
    async (fault) => {
      const directory = join(evidence, fault)
      mkdirSync(directory, { recursive: true })
      const path = join(directory, 'application.db')
      const children: Awaited<ReturnType<typeof launch>>[] = []
      try {
        const first = await launch(path, 'accept-only')
        children.push(first)
        const response = await fetch(`${first.url}/api/runs`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ message: 'SO-2026-0003' }),
        })
        expect(response.status).toBe(202)
        const accepted = (await response.json()) as { runId: string }
        await stop(first.child)
        if (fault !== 'accepted') {
          const interrupted = await launch(path, fault)
          children.push(interrupted)
          expect(await interrupted.exited).toBe(73)
        }
        const recovered = await launch(path, 'recover')
        children.push(recovered)
        await waitState(recovered.url, accepted.runId, 'completed')
        const events = (await (
          await fetch(`${recovered.url}/api/runs/${accepted.runId}/events/json`, {
            headers: headers(),
          })
        ).json()) as { events: Array<{ type: string }> }
        expect(events.events.filter((event) => event.type === 'message.user')).toHaveLength(1)
        await stop(recovered.child)
        const db = openDatabase(path)
        try {
          expect(
            db
              .prepare("SELECT COUNT(*) AS n FROM agent_events WHERE type = 'agent.tool_results'")
              .get(),
          ).toEqual({ n: 1 })
          // 开始动作不是成功凭据 退出后仍确认原查询且使用同一公开执行标识
          const actions = db
            .prepare(
              "SELECT type,payload_json AS payload FROM agent_events WHERE type IN ('tool.requested','tool.completed') ORDER BY sequence",
            )
            .all() as Array<{ type: string; payload: string }>
          expect(actions.filter((event) => event.type === 'tool.requested')).toHaveLength(1)
          expect(actions.filter((event) => event.type === 'tool.completed')).toHaveLength(1)
          expect(JSON.parse(actions[0]!.payload).executionId).toBe(
            JSON.parse(actions[1]!.payload).executionId,
          )
          expect(db.prepare('SELECT COUNT(*) AS n FROM p7_calls').get()).toEqual({
            n: fault === 'after-model-response' ? 3 : 2,
          })
          writeFileSync(
            join(directory, 'evidence.json'),
            JSON.stringify(
              {
                fault,
                accepted,
                events,
                tasks: db.prepare('SELECT task_id,status,attempt FROM p6_tasks').all(),
                calls: db.prepare('SELECT operation_id,status,actual FROM p7_calls').all(),
                logs: children.map((child) => child.output()),
              },
              null,
              2,
            ),
          )
        } finally {
          db.close()
        }
      } finally {
        for (const child of children) await stop(child.child)
      }
    },
    45000,
  )

  it('补问暂停后 API 重启 客户回复绑定原问题并可幂等重放', async () => {
    const directory = join(evidence, 'continue-after-restart')
    mkdirSync(directory, { recursive: true })
    const path = join(directory, 'application.db')
    const children: Awaited<ReturnType<typeof launch>>[] = []
    try {
      const first = await launch(path, 'recover')
      children.push(first)
      const accepted = (await (
        await fetch(`${first.url}/api/runs`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ message: '帮我查询订单' }),
        })
      ).json()) as { runId: string }
      await waitState(first.url, accepted.runId, 'awaiting_input')
      await stop(first.child)
      const next = await launch(path, 'recover')
      children.push(next)
      const reply = () =>
        fetch(`${next.url}/api/runs/${accepted.runId}/messages`, {
          method: 'POST',
          headers: headers('reply'),
          body: JSON.stringify({ message: 'SO-2026-0003' }),
        })
      expect((await reply()).status).toBe(202)
      await waitState(next.url, accepted.runId, 'completed')
      expect((await reply()).status).toBe(202)
      await stop(next.child)
      const db = openDatabase(path)
      try {
        const messages = db
          .prepare("SELECT payload_json FROM agent_events WHERE type = 'message.user'")
          .all() as Array<{ payload_json: string }>
        expect(messages).toHaveLength(2)
        expect(JSON.parse(messages[1]!.payload_json).replyToToolCallId).toContain('ask_user')
        expect(db.prepare('SELECT COUNT(*) AS n FROM p6_commands').get()).toEqual({ n: 2 })
        writeFileSync(
          join(directory, 'evidence.json'),
          JSON.stringify(
            {
              accepted,
              messages,
              calls: db.prepare('SELECT operation_id,status FROM p7_calls').all(),
            },
            null,
            2,
          ),
        )
      } finally {
        db.close()
      }
    } finally {
      for (const child of children) await stop(child.child)
    }
  }, 45000)
})
