import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const root = 'C:/Users/htlocal/AppData/Local/Temp/customer-return-ui-20260926-124648'
const { apiUrl, webUrl } = JSON.parse(readFileSync(`${root}/browser-environment.json`, 'utf8'))
const require = createRequire('D:/project/agent-new/aftersales/packages/persistence/package.json')
const Database = require('better-sqlite3')
const db = new Database(`${root}/browser-application.db`, { readonly: true })
const channel = new Database(`${root}/browser-channel.db`, { readonly: true })
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
  userDataDir: `${root}/chrome-profile-${Date.now()}`, args: ['--no-first-run','--disable-extensions'] })
const page = await browser.newPage()
const evidence = { requests: [], console: [], checks: [], screenshots: [] }
page.on('pageerror', error => evidence.console.push({ type: 'pageerror', message: String(error) }))
page.on('console', message => { if (['error','warn'].includes(message.type())) evidence.console.push({ type: message.type(), message: message.text() }) })
page.on('request', request => { if (request.url().startsWith(apiUrl) && request.method() === 'POST') evidence.requests.push({ url: request.url(), key: request.headers()['idempotency-key'], body: request.postData() }) })
const request = async (path, body, token = 'cust-token-1001', key) => {
  const response = await fetch(`${apiUrl}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const result = await response.json()
  return { status: response.status, result }
}
const waitText = text => page.waitForFunction(text => document.body.innerText.includes(text), { timeout: 30000 }, text)
const button = async text => {
  const buttons = await page.$$('button')
  for (const candidate of buttons) if ((await candidate.evaluate(element => element.textContent.trim())) === text) { await candidate.click(); return }
  throw new Error(`button missing ${text}`)
}
const screenshot = async name => { await page.screenshot({ path: `${root}/${name}.png`, fullPage: true }); evidence.screenshots.push(name) }
try {
  await page.setViewport({ width: 1440, height: 1000 })
  await page.goto(`${webUrl}/workbench`, { waitUntil: 'networkidle2', timeout: 120000 })
  await page.waitForSelector('#demo-identity', { timeout: 30000 })
  await page.select('#demo-identity', 'cust-token-1001')
  await page.waitForSelector('#customer-message:not([disabled])')
  assert.match(await page.title(), /售后|AfterSales|有据/)
  const created = page.waitForResponse(response => response.url() === `${apiUrl}/api/runs` && response.request().method() === 'POST')
  await page.type('#customer-message', '订单 SO-2026-0001 商品质量问题 申请退货退款')
  await page.focus('#customer-message')
  await page.keyboard.press('Enter')
  const { runId } = await (await created).json()
  evidence.runId = runId
  await waitText('等待审批 通过前无需寄回')
  assert.equal(await page.$('#return-tracking'), null)
  evidence.checks.push('审批前无寄回表单')
  await screenshot('desktop-awaiting-approval')
  const { result } = await request('/api/approvals', null, 'supervisor-token')
  const approval = result.approvals.find(item => item.runId === runId)
  assert.ok(approval)
  const approved = await request(`/api/runs/${runId}/approvals/${approval.approvalId}/decide`, { decision: 'approved', decidedBy: 'supervisor' }, 'supervisor-token')
  assert.equal(approved.status, 202)
  await page.waitForSelector('#return-tracking:not([disabled])', { timeout: 30000 })
  const dto = (await request(`/api/runs/${runId}/customer-progress`)).result.progress
  evidence.approvedProgress = dto
  assert.equal(dto.returnNo, db.prepare('SELECT return_no FROM p6_conversation_refunds WHERE run_id = ?').get(runId).return_no)
  await page.focus('#return-tracking')
  await page.keyboard.press('Enter')
  await waitText('请输入 1 至 100 个字符的物流单号')
  evidence.checks.push('键盘空单号校验反馈')
  await screenshot('desktop-validation')
  await page.type('#return-tracking', 'LOCAL-网页寄回-001')
  await page.setRequestInterception(true)
  let failOnce = true
  page.on('request', req => {
    if (req.isInterceptResolutionHandled()) return
    if (failOnce && req.method() === 'POST' && req.url().endsWith(`/api/runs/${runId}/messages`)) {
      failOnce = false
      void req.abort('failed')
    } else void req.continue()
  })
  await button('登记寄回')
  await waitText('未能确认寄回登记')
  assert.equal((await request(`/api/runs/${runId}/customer-progress`)).result.progress.shipmentRegistered, false)
  assert.equal(await page.$eval('#return-tracking', element => element.readOnly), true)
  await screenshot('desktop-network-retry')
  await page.reload({ waitUntil: 'networkidle2' })
  await waitText('本次提交已保存')
  assert.equal(await page.$eval('#return-tracking', element => element.value), 'LOCAL-网页寄回-001')
  await button('使用原请求重试')
  await waitText('已登记寄回 等待仓库确认收货 尚未退款')
  const posts = evidence.requests.filter(item => item.url.endsWith(`/api/runs/${runId}/messages`))
  assert.equal(posts.length, 2)
  assert.equal(posts[0].key, posts[1].key)
  assert.equal(posts[0].body, posts[1].body)
  evidence.checks.push('失败不假成功 刷新恢复原请求键和请求体')
  const replay = await request(`/api/runs/${runId}/messages`, JSON.parse(posts[1].body), 'cust-token-1001', posts[1].key)
  assert.equal(replay.status, 202)
  const beforeReceive = channel.prepare('SELECT COALESCE(SUM(submissions),0) submissions, COALESCE(SUM(charges),0) charges FROM p6_channel').get()
  assert.deepEqual(beforeReceive, { submissions: 0, charges: 0 })
  evidence.beforeReceive = beforeReceive
  await screenshot('desktop-waiting-receipt')
  await page.setViewport({ width: 390, height: 844 })
  await page.$eval('[aria-label="原售后进度"]', element => element.scrollIntoView({ block: 'center' }))
  await screenshot('mobile-waiting-receipt')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  evidence.checks.push('390px 窄屏无水平溢出')
  await page.setViewport({ width: 1440, height: 1000 })
  await page.select('#demo-identity', 'cust-token-1002')
  await page.waitForFunction(() => !document.querySelector('[aria-label="原售后进度"]'))
  assert.equal(await page.evaluate(value => document.body.innerText.includes(value), dto.returnNo), false)
  await page.select('#demo-identity', 'cust-token-1001')
  await waitText('已登记寄回 等待仓库确认收货 尚未退款')
  evidence.checks.push('身份切换隔离与恢复')
  await page.setOfflineMode(true)
  await page.waitForFunction(() => document.body.innerText.includes('连接中断') || document.body.innerText.includes('无法核验'), { timeout: 20000 })
  await page.setOfflineMode(false)
  await waitText('已登记寄回 等待仓库确认收货 尚未退款')
  const denied = await request('/api/operations/receive-goods', { returnNo: dto.returnNo })
  assert.equal(denied.status, 403)
  const received = await request('/api/operations/receive-goods', { returnNo: dto.returnNo }, 'operator-token')
  assert.equal(received.status, 202)
  await waitText('模拟渠道已确认退款成功')
  await page.waitForFunction(() => document.querySelector('[aria-label="原售后进度"]')?.textContent.includes('模拟渠道已确认退款成功'))
  await screenshot('desktop-confirmed-refund')
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForFunction(() => document.querySelector('[aria-label="原售后进度"]')?.textContent.includes('模拟渠道已确认退款成功'))
  const counts = channel.prepare('SELECT COALESCE(SUM(submissions),0) submissions, COALESCE(SUM(charges),0) charges FROM p6_channel').get()
  assert.deepEqual(counts, { submissions: 1, charges: 1 })
  const events = (await request(`/api/runs/${runId}/events/json`)).result.events
  assert.equal(events.filter(event => event.type === 'run.completed').length, 1)
  const registered = db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE run_id = ? AND action = 'return_shipment_recorded'").get(runId)
  assert.equal(registered.n, 1)
  const commands = db.prepare('SELECT COUNT(*) n FROM p6_commands WHERE customer_id = ? AND request_key = ?').get('C1001', posts[1].key)
  assert.equal(commands.n, 1)
  evidence.final = { counts, registered, commands, progress: (await request(`/api/runs/${runId}/customer-progress`)).result.progress,
    refund: db.prepare('SELECT refund_no,return_no,status FROM refunds WHERE return_no = ?').get(dto.returnNo),
    afterSale: db.prepare('SELECT return_no,status FROM return_requests WHERE return_no = ?').get(dto.returnNo), events,
    assistantResults: await page.$$eval('article[data-role="assistant"] p', elements => elements.map(element => element.textContent)) }
  assert.equal(evidence.final.assistantResults.filter(text => text === '模拟渠道已确认退款成功').length, 1)
  evidence.checks.push('SSE 重连和刷新无重复结果 仓库收货后渠道及业务一致成功')
  evidence.page = { url: page.url(), title: await page.title(), hasOverlay: await page.$('nextjs-portal [data-nextjs-dialog-overlay]') !== null }
  assert.equal(evidence.page.hasOverlay, false)
  console.log(JSON.stringify({ checks: evidence.checks, final: { counts, registered, commands } }, null, 2))
} catch (error) {
  evidence.failure = String(error.stack)
  await screenshot('browser-failure')
  console.error(error)
  process.exitCode = 1
} finally {
  writeFileSync(`${root}/browser-evidence.json`, JSON.stringify(evidence, null, 2))
  await browser.close()
  db.close(); channel.close()
}
