import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const root = 'C:/Users/htlocal/AppData/Local/Temp/customer-return-ui-20260926-124648'
const { apiUrl, webUrl } = JSON.parse(readFileSync(`${root}/browser-environment.json`, 'utf8'))
const require = createRequire('D:/project/agent-new/aftersales/packages/persistence/package.json')
const Database = require('better-sqlite3')
const db = new Database(`${root}/browser-application.db`)
// 独立实验库只准备尚未申请售后的基础订单日期
assert.equal(db.prepare("SELECT COUNT(*) n FROM return_requests WHERE order_no = 'SO-2026-0006'").get().n, 0)
db.prepare("UPDATE orders SET delivered_at = ?, shipped_at = ? WHERE order_no = 'SO-2026-0006'").run(new Date().toISOString(), new Date().toISOString())
const evidence = { requests: [], checks: [], errors: [] }
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, userDataDir: `${root}/chrome-pending-${Date.now()}` })
const page = await browser.newPage()
page.on('pageerror', error => evidence.errors.push(String(error)))
const waitText = text => page.waitForFunction(text => document.body.innerText.includes(text), { timeout: 30000 }, text)
const button = async text => {
  for (const element of await page.$$('button')) if ((await element.evaluate(node => node.textContent.trim())) === text) { await element.click(); return }
  throw new Error(`missing button ${text}`)
}
try {
  await page.setViewport({ width: 1440, height: 1000 })
  await page.goto(`${webUrl}/workbench`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('#demo-identity')
  await page.select('#demo-identity', 'cust-token-1002')
  await page.waitForSelector('#customer-message:not([disabled])')
  const created = page.waitForResponse(response => response.url() === `${apiUrl}/api/runs` && response.request().method() === 'POST')
  await page.type('#customer-message', 'SO-2026-0006 商品质量问题 退货退款')
  await page.keyboard.press('Enter')
  const { runId } = await (await created).json()
  evidence.runId = runId
  await page.waitForSelector('#return-tracking:not([disabled])', { timeout: 30000 })
  await page.type('#return-tracking', 'LOCAL-SWITCH-006')
  let held = null
  let result = null
  await page.setRequestInterception(true)
  page.on('request', async request => {
    if (request.isInterceptResolutionHandled()) return
    if (request.url().endsWith(`/api/runs/${runId}/messages`) && request.method() === 'POST') {
      held = request
      evidence.requests.push({ url: request.url(), key: request.headers()['idempotency-key'], body: request.postData() })
      // 原请求实发本地 API 只延迟交还真实响应
      const response = await fetch(request.url(), { method: 'POST', headers: { Authorization: 'Bearer cust-token-1002', 'Content-Type': 'application/json', 'Idempotency-Key': request.headers()['idempotency-key'] }, body: request.postData() })
      result = { status: response.status, body: await response.text(), contentType: 'application/json', headers: { 'access-control-allow-origin': '*' } }
    } else void request.continue()
  })
  await page.$eval('#return-tracking', element => { element.form.requestSubmit(); element.form.requestSubmit() })
  while (!result) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(result.status, 202)
  await button('新会话')
  await waitText('您好 请告诉我们遇到了什么问题')
  await page.select('#demo-identity', 'cust-token-1001')
  await held.respond(result).catch(() => {})
  await page.waitForFunction(() => !document.body.innerText.includes('LOCAL-SWITCH-006'))
  assert.equal(evidence.requests.length, 1)
  await page.select('#demo-identity', 'cust-token-1002')
  await page.waitForFunction(id => [...document.querySelectorAll('button')].some(button => button.textContent.includes(id)), {}, runId)
  await page.evaluate(id => [...document.querySelectorAll('button')].find(button => button.textContent.includes(id)).click(), runId)
  await waitText('LOCAL-SWITCH-006')
  await waitText('已登记寄回 等待仓库确认收货 尚未退款')
  evidence.commands = db.prepare('SELECT COUNT(*) n FROM p6_commands WHERE customer_id = ? AND request_key = ?').get('C1002', evidence.requests[0].key)
  evidence.registered = db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE run_id = ? AND action = 'return_shipment_recorded'").get(runId)
  assert.deepEqual(evidence.commands, { n: 1 })
  assert.deepEqual(evidence.registered, { n: 1 })
  evidence.checks.push('同步双提交只发一次请求', '真实 API 受理期间切换新会话和身份 迟到响应不串数据', '返回原会话读取已登记事实')
  assert.deepEqual(evidence.errors, [])
  await page.screenshot({ path: `${root}/desktop-pending-switch.png`, fullPage: true })
  console.log(JSON.stringify(evidence, null, 2))
} catch (error) {
  evidence.failure = String(error.stack)
  console.error(error)
  process.exitCode = 1
} finally {
  writeFileSync(`${root}/pending-switch-evidence.json`, JSON.stringify(evidence, null, 2))
  await browser.close(); db.close()
}
process.exit(process.exitCode ?? 0)
