import { expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, startP6PaymentSimulator } from '@aftersales/persistence'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const evidence = join(
  root,
  'docs/experiments/business-results',
  new Date().toISOString().replaceAll(':', '-'),
)
const headers = { Authorization: 'Bearer supervisor-token', 'Content-Type': 'application/json' }

async function launch(path: string, paymentUrl: string, mode: string, type: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      join(root, 'apps/api/test/fixtures/business-process.ts'),
      path,
      paymentUrl,
      mode,
      type,
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
  const exited = new Promise<number | null>((resolveExit) => child.once('close', resolveExit))
  const url = await new Promise<string>((resolveReady, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(log || '启动超时'))
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
      reject(new Error(`退出 ${code} ${log}`))
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
async function waitFor(path: string, status: string) {
  const db = openDatabase(path)
  try {
    for (let i = 0; i < 150; i++) {
      if (
        (
          db.prepare("SELECT status FROM return_requests WHERE return_no = 'RT1'").get() as {
            status: string
          }
        ).status === status
      )
        return
      await new Promise((done) => setTimeout(done, 50))
    }
    throw new Error(`业务未达到 ${status}`)
  } finally {
    db.close()
  }
}

it.each(['accepted', 'after-payment-response', 'after-payment-checkpoint', 'receipt'])(
  '正式审批 HTTP 与 %s 边界跨进程恢复',
  async (fault) => {
    const directory = join(evidence, fault)
    mkdirSync(directory, { recursive: true })
    const path = join(directory, 'application.db')
    const channel = openDatabase(join(directory, 'channel.db'))
    const server = await startP6PaymentSimulator(channel)
    const paymentUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const children: Awaited<ReturnType<typeof launch>>[] = []
    const type = fault === 'receipt' ? 'return' : 'refund_only'
    try {
      const first = await launch(path, paymentUrl, 'accept-only', type)
      children.push(first)
      const decided = await fetch(`${first.url}/api/runs/business-run/approvals/AP1/decide`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ decision: 'approved', decidedBy: 'supervisor' }),
      })
      expect(decided.status).toBe(202)
      await stop(first.child)
      if (fault.startsWith('after-')) {
        const interrupted = await launch(path, paymentUrl, fault, type)
        children.push(interrupted)
        expect(await interrupted.exited).toBe(73)
      }
      let recovered = await launch(path, paymentUrl, 'recover', type)
      children.push(recovered)
      if (fault === 'receipt') {
        await waitFor(path, 'awaiting_buyer_shipment')
        const shipped = await fetch(`${recovered.url}/api/operations/return-shipment`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ returnNo: 'RT1', trackingNo: 'LOCAL-RETURN-1' }),
        })
        expect(shipped.status).toBe(200)
        await stop(recovered.child)
        const receiptApi = await launch(path, paymentUrl, 'accept-only', type)
        children.push(receiptApi)
        const receive = () =>
          fetch(`${receiptApi.url}/api/operations/receive-goods`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ returnNo: 'RT1' }),
          })
        expect((await receive()).status).toBe(202)
        expect((await receive()).status).toBe(202)
        await stop(receiptApi.child)
        recovered = await launch(path, paymentUrl, 'recover', type)
        children.push(recovered)
      }
      await waitFor(path, 'completed')
      await stop(recovered.child)
      expect(channel.prepare('SELECT submissions, charges FROM p6_channel').get()).toEqual({
        submissions: 1,
        charges: 1,
      })
      const db = openDatabase(path)
      try {
        expect(db.prepare('SELECT owner,state FROM execution_ownership').get()).toEqual({
          owner: 'p6',
          state: 'succeeded',
        })
        writeFileSync(
          join(directory, 'evidence.json'),
          JSON.stringify(
            {
              fault,
              tasks: db.prepare('SELECT task_id,status,attempt FROM p6_tasks').all(),
              ownership: db
                .prepare('SELECT business_key,owner,holder,state FROM execution_ownership')
                .all(),
              channel: channel
                .prepare('SELECT business_key,submissions,charges FROM p6_channel')
                .all(),
              logs: children.map((item) => item.log()),
            },
            null,
            2,
          ),
        )
      } finally {
        db.close()
      }
    } finally {
      for (const item of children) await stop(item.child)
      await new Promise<void>((done) => server.close(() => done()))
      channel.close()
    }
  },
  45000,
)
