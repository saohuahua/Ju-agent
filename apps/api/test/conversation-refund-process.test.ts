import { expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, startP6PaymentSimulator } from '@aftersales/persistence'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const evidence = join(
  root,
  'docs/experiments/p6-conversation-refund-evidence',
  `process-${new Date().toISOString().replaceAll(':', '-')}`,
)
const headers = (key = 'start', role = 'cust-token-1001') => ({
  Authorization: `Bearer ${role}`,
  'Content-Type': 'application/json',
  'Idempotency-Key': key,
})

async function launch(path: string, paymentUrl: string, mode: string, scenario: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      join(root, 'apps/api/test/fixtures/conversation-refund-process.ts'),
      path,
      paymentUrl,
      mode,
      scenario,
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  )
  let log = ''
  child.stdout?.on('data', (data) => {
    log += String(data)
  })
  child.stderr?.on('data', (data) => {
    log += String(data)
  })
  const exited = new Promise<number | null>((done) => child.once('close', done))
  const url = await new Promise<string>((ready, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`启动超时 ${log}`))
    }, 15000)
    child.once('message', (message) => {
      clearTimeout(timeout)
      ready((message as { url: string }).url)
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`提前退出 ${code} ${log}`))
    })
  })
  return { child, url, exited, log: () => log }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((done) => {
    child.once('close', () => done())
    child.kill()
  })
}
async function until(work: () => boolean) {
  for (let i = 0; i < 240; i++) {
    if (work()) return
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error('未到达预期数据库状态')
}

it.each([
  'before-business-accept',
  'after-business-accept',
  'after-approval-accept',
  'after-payment-response',
  'before-business-projection',
  'return-wait',
])(
  '客户正式 HTTP 发起 %s 强退与恢复 原调用最多投影一次且只有一笔退款',
  async (fault) => {
    const directory = mkdtempSync(join(tmpdir(), 'p6-refund-process-'))
    const target = join(evidence, fault)
    mkdirSync(target, { recursive: true })
    const path = join(directory, 'application.db')
    const channelPath = join(directory, 'channel.db')
    const channel = openDatabase(channelPath)
    const server = await startP6PaymentSimulator(channel)
    const paymentUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const children: Awaited<ReturnType<typeof launch>>[] = []
    const scenario =
      fault === 'after-approval-accept'
        ? 'approval'
        : fault === 'return-wait'
          ? 'return'
          : 'automatic'
    let db: ReturnType<typeof openDatabase> | undefined
    try {
      const first = await launch(path, paymentUrl, fault, scenario)
      children.push(first)
      const response = await fetch(`${first.url}/api/runs`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ message: '我要退款 SO-2026-0001' }),
      })
      expect(response.status).toBe(202)
      const accepted = (await response.json()) as { runId: string; commandId: string }
      db = openDatabase(path)
      const connection = db
      const link = () =>
        connection
          .prepare('SELECT * FROM p6_conversation_refunds WHERE run_id = ?')
          .get(accepted.runId) as
          | { return_no: string; approval_id: string; tool_call_id: string; projected: number }
          | undefined
      const decide = async (url: string) => {
        await until(() => Boolean(link()?.approval_id))
        expect(channel.prepare('SELECT COUNT(*) AS n FROM p6_channel').get()).toEqual({ n: 0 })
        const response = await fetch(
          `${url}/api/runs/${accepted.runId}/approvals/${link()!.approval_id}/decide`,
          {
            method: 'POST',
            headers: headers('approval', 'supervisor-token'),
            body: JSON.stringify({ decision: 'approved', decidedBy: 'supervisor' }),
          },
        )
        expect(response.status).toBe(202)
      }
      if (scenario === 'approval' || scenario === 'return') await decide(first.url)
      if (fault === 'return-wait') {
        await until(
          () =>
            (
              connection
                .prepare('SELECT status FROM agent_runs WHERE run_id = ?')
                .get(accepted.runId) as { status: string }
            ).status === 'awaiting_input',
        )
        expect(channel.prepare('SELECT COUNT(*) AS n FROM p6_channel').get()).toEqual({ n: 0 })
        await stop(first.child)
      } else expect(await first.exited).toBe(73)
      const interrupted = {
        tasks: connection.prepare('SELECT task_id,status,attempt FROM p6_tasks').all(),
        channel: channel.prepare('SELECT business_key,submissions,charges FROM p6_channel').all(),
        links: connection.prepare('SELECT * FROM p6_conversation_refunds').all(),
        events: connection.prepare('SELECT type,payload_json FROM agent_events').all(),
      }
      const recovered = await launch(path, paymentUrl, 'recover', scenario)
      children.push(recovered)
      if (fault === 'return-wait') {
        const returnNo = link()!.return_no
        const shipment = () =>
          fetch(`${recovered.url}/api/runs/${accepted.runId}/messages`, {
            method: 'POST',
            headers: headers('shipment'),
            body: JSON.stringify({
              message: '重启后已经寄回',
              returnShipment: { returnNo, trackingNo: 'LOCAL-PROCESS-RETURN' },
            }),
          })
        expect((await shipment()).status).toBe(202)
        expect((await shipment()).status).toBe(202)
        expect(channel.prepare('SELECT COUNT(*) AS n FROM p6_channel').get()).toEqual({ n: 0 })
        const receive = () =>
          fetch(`${recovered.url}/api/operations/receive-goods`, {
            method: 'POST',
            headers: headers('receipt', 'supervisor-token'),
            body: JSON.stringify({ returnNo }),
          })
        expect((await receive()).status).toBe(202)
        expect((await receive()).status).toBe(202)
      }
      await until(() => link()?.projected === 1)
      const customerEvents = (await (
        await fetch(`${recovered.url}/api/runs/${accepted.runId}/events/json`, {
          headers: headers(),
        })
      ).json()) as { events: Array<{ type: string }> }
      expect(customerEvents.events.filter((event) => event.type === 'run.completed')).toHaveLength(
        1,
      )
      await stop(recovered.child)
      expect(channel.prepare('SELECT submissions,charges FROM p6_channel').get()).toEqual({
        submissions: 1,
        charges: 1,
      })
      expect(
        connection.prepare('SELECT status FROM refunds WHERE return_no = ?').get(link()!.return_no),
      ).toEqual({ status: 'succeeded' })
      const results = (
        connection
          .prepare(
            "SELECT payload_json FROM agent_events WHERE run_id = ? AND type = 'agent.tool_results'",
          )
          .all(accepted.runId) as { payload_json: string }[]
      ).flatMap((row) => JSON.parse(row.payload_json).results) as Array<{
        toolCallId: string
        content: string
      }>
      const result = results.filter((item) => item.toolCallId === link()!.tool_call_id)
      expect(result).toHaveLength(1)
      expect(JSON.parse(result[0]!.content).refundStatus).toBe('succeeded')
      const calls = connection
        .prepare('SELECT operation_id,attempt,status,actual,reserved FROM p7_calls')
        .all()
      expect(calls).toHaveLength(3)
      expect(connection.prepare('SELECT SUM(actual) AS cost FROM p7_calls').get()).toEqual({
        cost: 30,
      })
      if (fault === 'after-payment-response')
        expect(
          (channel.prepare('SELECT COUNT(*) AS n FROM p6_channel_queries').get() as { n: number })
            .n,
        ).toBeGreaterThan(0)
      writeFileSync(
        join(target, 'evidence.json'),
        JSON.stringify(
          {
            fault,
            directory,
            accepted,
            interrupted,
            customerEvents,
            results,
            tasks: connection
              .prepare('SELECT task_id,command_id,status,attempt FROM p6_tasks')
              .all(),
            ownership: connection.prepare('SELECT * FROM execution_ownership').all(),
            channel: channel.prepare('SELECT * FROM p6_channel').all(),
            queries: channel.prepare('SELECT * FROM p6_channel_queries').all(),
            calls,
            logs: children.map((child) => child.log()),
          },
          null,
          2,
        ),
      )
    } finally {
      for (const child of children) await stop(child.child)
      db?.close()
      await new Promise<void>((done) => server.close(() => done()))
      channel.close()
      copyFileSync(path, join(target, 'application.db'))
      copyFileSync(channelPath, join(target, 'channel.db'))
    }
  },
  45000,
)
