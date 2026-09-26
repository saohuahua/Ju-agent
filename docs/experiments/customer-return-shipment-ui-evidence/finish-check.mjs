import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const root = 'C:/Users/htlocal/AppData/Local/Temp/customer-return-ui-20260926-124648'
const environment = JSON.parse(readFileSync(`${root}/browser-environment.json`, 'utf8'))
const { apiUrl, webUrl, paymentUrl } = environment
const evidence = JSON.parse(readFileSync(`${root}/browser-evidence-before-offline-fix.json`, 'utf8'))
delete evidence.failure
evidence.console = []
const { runId, approvedProgress: dto } = evidence
const require = createRequire('D:/project/agent-new/aftersales/packages/persistence/package.json')
const Database = require('better-sqlite3')
const db = new Database(`${root}/browser-application.db`, { readonly: true })
const channel = new Database(`${root}/browser-channel.db`, { readonly: true })
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, userDataDir: `${root}/chrome-finish-${Date.now()}`, args: ['--no-first-run','--disable-extensions'] })
const page = await browser.newPage()
page.on('pageerror', error => evidence.console.push({ type: 'pageerror', message: String(error) }))
page.on('console', message => { if (['warn','error'].includes(message.type())) evidence.console.push({ type: message.type(), message: message.text() }) })
const request = async (path, body, token = 'cust-token-1001', key) => {
  const response = await fetch(`${apiUrl}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, result: await response.json() }
}
const waitText = text => page.waitForFunction(text => document.body.innerText.includes(text), { timeout: 30000 }, text)
const screenshot = async name => { await page.screenshot({ path: `${root}/${name}.png`, fullPage: true }); evidence.screenshots.push(name) }
try {
  await page.setViewport({ width: 1440, height: 1000 })
  await page.goto(`${webUrl}/workbench`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('#demo-identity')
  await page.select('#demo-identity', 'cust-token-1001')
  await page.waitForFunction(id => [...document.querySelectorAll('button')].some(button => button.textContent.includes(id)), {}, runId)
  await page.evaluate(id => [...document.querySelectorAll('button')].find(button => button.textContent.includes(id)).click(), runId)
  await waitText('已登记寄回 等待仓库确认收货 尚未退款')
  await page.setOfflineMode(true)
  await waitText('连接已离线')
  assert.equal(await page.$('#return-tracking'), null)
  await screenshot('desktop-offline')
  await page.setOfflineMode(false)
  await waitText('已登记寄回 等待仓库确认收货 尚未退款')
  evidence.checks.push('浏览器离线明确提示 恢复联网重查事实')
  // 仅终止本次隔离 API 以真实断开 SSE
  process.kill(environment.apiPid)
  await waitText('连接中断')
  await screenshot('desktop-sse-disconnected')
  const env = Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'].map(key => [key, process.env[key] ?? '']))
  const child = spawn(process.execPath, ['--import', 'file:///D:/project/agent-new/aftersales/node_modules/tsx/dist/loader.mjs', 'D:/project/agent-new/aftersales/apps/api/src/main.ts'], {
    cwd: root, env: { ...env, DB_PATH: `${root}/browser-application.db`, API_PORT: new URL(apiUrl).port, P6_BUSINESS_MODE: 'simulation', P6_PAYMENT_SIMULATOR_URL: paymentUrl }, windowsHide: true, detached: true, stdio: ['ignore','pipe','pipe'] })
  await new Promise((resolve, reject) => {
    child.stdout.on('data', bytes => { appendFileSync(`${root}/browser-api-restarted.log`, bytes); if (String(bytes).includes('售后 API 已启动')) resolve() })
    child.stderr.on('data', bytes => appendFileSync(`${root}/browser-api-restarted.log`, bytes))
    child.once('exit', code => reject(new Error(`API restart exit ${code}`)))
  })
  child.stdout.destroy(); child.stderr.destroy(); child.unref()
  writeFileSync(`${root}/browser-environment.json`, JSON.stringify({ ...environment, oldApiPid: environment.apiPid, apiPid: child.pid }, null, 2))
  await waitText('实时连接中')
  await page.waitForFunction(() => document.querySelector('[aria-label="原售后进度"]')?.textContent.includes('等待仓库确认收货'))
  evidence.checks.push('API 进程重启真实断开 SSE 原会话自动续传')
  assert.equal((await request('/api/operations/receive-goods', { returnNo: dto.returnNo })).status, 403)
  assert.equal((await request('/api/operations/receive-goods', { returnNo: dto.returnNo }, 'operator-token')).status, 202)
  await page.waitForFunction(() => document.querySelector('[aria-label="原售后进度"]')?.textContent.includes('模拟渠道已确认退款成功'), { timeout: 30000 })
  await screenshot('desktop-confirmed-refund')
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForFunction(() => document.querySelector('[aria-label="原售后进度"]')?.textContent.includes('模拟渠道已确认退款成功'))
  const counts = channel.prepare('SELECT COALESCE(SUM(submissions),0) submissions, COALESCE(SUM(charges),0) charges FROM p6_channel').get()
  assert.deepEqual(counts, { submissions: 1, charges: 1 })
  const events = (await request(`/api/runs/${runId}/events/json`)).result.events
  assert.equal(events.filter(event => event.type === 'run.completed').length, 1)
  const registered = db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE run_id = ? AND action = 'return_shipment_recorded'").get(runId)
  assert.equal(registered.n, 1)
  const key = evidence.requests.find(item => item.url.endsWith('/messages')).key
  const commands = db.prepare('SELECT COUNT(*) n FROM p6_commands WHERE customer_id = ? AND request_key = ?').get('C1001', key)
  assert.equal(commands.n, 1)
  evidence.final = { counts, registered, commands, progress: (await request(`/api/runs/${runId}/customer-progress`)).result.progress,
    refund: db.prepare('SELECT refund_no,return_no,status FROM refunds WHERE return_no = ?').get(dto.returnNo),
    afterSale: db.prepare('SELECT return_no,status FROM return_requests WHERE return_no = ?').get(dto.returnNo), events,
    assistantResults: await page.$$eval('article[data-role="assistant"] p', elements => elements.map(element => element.textContent)) }
  assert.equal(evidence.final.assistantResults.filter(text => text === '模拟渠道已确认退款成功').length, 1)
  evidence.checks.push('SSE 重连和刷新无重复结果 收货后渠道业务及页面一致成功')
  evidence.page = { url: page.url(), title: await page.title(), hasOverlay: await page.$('nextjs-portal [data-nextjs-dialog-overlay]') !== null }
  assert.equal(evidence.page.hasOverlay, false)
  await page.setViewport({ width: 390, height: 844 })
  await page.$eval('[aria-label="原售后进度"]', element => element.scrollIntoView({ block: 'center' }))
  await screenshot('mobile-confirmed-refund')
  console.log(JSON.stringify({ checks: evidence.checks, final: { counts, registered, commands } }, null, 2))
} catch (error) {
  evidence.failure = String(error.stack)
  await screenshot('browser-finish-failure')
  console.error(error)
  process.exitCode = 1
} finally {
  writeFileSync(`${root}/browser-evidence-final.json`, JSON.stringify(evidence, null, 2))
  await browser.close(); db.close(); channel.close()
}
