import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../../../packages/persistence/src/db.js'

/** 独立 HTTP 子进程承载流 真实取消第一条连接后用确认游标建立新连接 */
it('P6 SSE 真实断网重连不漏不重且不泄漏原始结果', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const folder = join(
    root,
    'docs/experiments/p6-sse-results',
    new Date().toISOString().replaceAll(':', '-'),
  )
  mkdirSync(folder, { recursive: true })
  const dbPath = join(folder, 'application.db')
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(root, 'apps/api/test/fixtures/p6-sse-process.ts'), dbPath],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  )
  const exited = new Promise((resolveExit) => child.once('close', resolveExit))
  let logs = ''
  child.stdout?.on('data', (data) => {
    logs += String(data)
  })
  child.stderr?.on('data', (data) => {
    logs += String(data)
  })
  let firstText = ''
  let secondText = ''
  let passed = false
  try {
    const ready = await new Promise<{ url: string; taskId: string }>((resolveReady, reject) => {
      child.once('message', (message) => resolveReady(message as { url: string; taskId: string }))
      child.once('error', reject)
    })
    const url = `${ready.url}/commands/${ready.taskId}/events`
    const stop = new AbortController()
    const first = await fetch(url, { headers: { 'Test-Customer': 'C1' }, signal: stop.signal })
    expect(first.headers.get('cache-control')).toContain('no-transform')
    const reader = first.body!.getReader()
    while (!firstText.includes('"step":"model"')) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error('首个事件缺失')
      firstText += new TextDecoder().decode(chunk.value)
    }
    const firstId = Number(/id: (\d+)/u.exec(firstText)?.[1])
    expect(firstId).toBeGreaterThan(0)
    stop.abort()
    await reader.cancel().catch(() => undefined)
    const finished = new Promise((resolveFinished) => child.once('message', resolveFinished))
    child.send('continue')
    await finished
    const second = await fetch(url, {
      headers: { 'Test-Customer': 'C1', 'Last-Event-ID': String(firstId) },
    })
    secondText = await second.text()
    const ids = [...secondText.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]))
    expect(ids).toEqual([firstId + 1, firstId + 2])
    expect(secondText).not.toContain('"step":"model"')
    expect(secondText).toContain('"step":"read"')
    expect(secondText).toContain('"status":"completed"')
    expect(firstText + secondText).not.toContain('private')
    expect((await fetch(url, { headers: { 'Test-Customer': 'C2' } })).status).toBe(404)
    expect(
      (await fetch(url, { headers: { 'Test-Customer': 'C1', 'Last-Event-ID': '-1' } })).status,
    ).toBe(400)
    passed = true
  } finally {
    child.kill()
    await exited
    const db = openDatabase(dbPath)
    writeFileSync(
      join(folder, 'terminal-state.json'),
      JSON.stringify(
        {
          passed,
          events: db.prepare('SELECT * FROM p6_events').all(),
          tasks: db.prepare('SELECT * FROM p6_tasks').all(),
        },
        null,
        2,
      ),
    )
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
    writeFileSync(join(folder, 'first-connection.sse'), firstText)
    writeFileSync(join(folder, 'reconnected.sse'), secondText)
    writeFileSync(join(folder, 'process.log'), logs)
    console.log(`P6 SSE 证据 ${folder}`)
  }
}, 20_000)
