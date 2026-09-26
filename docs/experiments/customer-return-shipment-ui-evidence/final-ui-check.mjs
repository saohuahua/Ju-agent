import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
const root = 'C:/Users/htlocal/AppData/Local/Temp/customer-return-ui-20260926-124648'
const { apiUrl, webUrl } = JSON.parse(readFileSync(`${root}/browser-environment.json`, 'utf8'))
const { runId, approvedProgress: dto } = JSON.parse(readFileSync(`${root}/browser-evidence-final.json`, 'utf8'))
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, userDataDir: `${root}/chrome-final-${Date.now()}` })
const evidence = { checks: [], errors: [], requests: [] }
const page = await browser.newPage()
page.on('pageerror', error => evidence.errors.push(String(error)))
const waitText = text => page.waitForFunction(text => document.body.innerText.includes(text), { timeout: 30000 }, text)
const chooseRun = async () => {
  await page.waitForFunction(id => [...document.querySelectorAll('button')].some(button => button.textContent.includes(id)), {}, runId)
  await page.evaluate(id => [...document.querySelectorAll('button')].find(button => button.textContent.includes(id)).click(), runId)
}
const button = async text => {
  for (const element of await page.$$('button')) if ((await element.evaluate(node => node.textContent.trim())) === text) { await element.click(); return }
  throw new Error(`missing button ${text}`)
}
try {
  await page.setViewport({ width: 1440, height: 1000 })
  await page.goto(`${webUrl}/workbench`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('#demo-identity')
  await page.select('#demo-identity', 'cust-token-1001')
  await chooseRun()
  await page.waitForFunction(() => document.querySelector('[aria-label="原售后进度"]')?.textContent.includes('模拟渠道已确认退款成功'))
  await page.$eval('[aria-label="原售后进度"]', element => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
  await page.screenshot({ path: `${root}/desktop-final.png`, fullPage: true })
  await page.setViewport({ width: 390, height: 844 })
  await page.$eval('[aria-label="原售后进度"]', element => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
  await page.screenshot({ path: `${root}/mobile-final.png`, fullPage: true })
  const box = await page.$eval('[aria-label="原售后进度"]', element => ({ card: element.getBoundingClientRect().height, thread: element.parentElement.getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > innerWidth }))
  assert.ok(box.thread >= 320)
  assert.ok(box.card < box.thread)
  assert.equal(box.overflow, false)
  evidence.checks.push('桌面与窄屏最终进度卡完整可读')
  await page.setViewport({ width: 1440, height: 1000 })
  await page.setRequestInterception(true)
  let held = null
  let hold = false
  page.on('request', request => {
    if (request.isInterceptResolutionHandled()) return
    if (hold && request.url().endsWith(`/api/runs/${runId}/customer-progress`)) { held = request; hold = false }
    else void request.continue()
  })
  hold = true
  await button('刷新进度')
  while (!held) await new Promise(resolve => setTimeout(resolve, 20))
  await button('新会话')
  await waitText('您好 请告诉我们遇到了什么问题')
  await held.continue().catch(() => {})
  await page.waitForFunction(() => !document.querySelector('[aria-label="原售后进度"]'))
  assert.equal(await page.evaluate(value => document.body.innerText.includes(value), dto.returnNo), false)
  evidence.checks.push('迟到进度响应不污染新会话')
  await chooseRun()
  await waitText('模拟渠道已确认退款成功')
  await page.select('#demo-identity', 'cust-token-1002')
  await page.waitForSelector('#customer-message:not([disabled])')
  assert.equal(await page.evaluate(value => document.body.innerText.includes(value), dto.returnNo), false)
  const created = page.waitForResponse(response => response.url() === `${apiUrl}/api/runs` && response.request().method() === 'POST')
  await page.type('#customer-message', '订单 SO-2026-0009 未发货 申请仅退款')
  await page.keyboard.press('Enter')
  const refundRun = (await (await created).json()).runId
  await page.waitForFunction(() => document.querySelector('[aria-label="原售后进度"]')?.textContent.includes('仅退款'), { timeout: 30000 })
  assert.equal(await page.$('#return-tracking'), null)
  await page.waitForFunction(() => document.querySelector('[aria-label="原售后进度"]')?.textContent.includes('模拟渠道已确认退款成功'))
  evidence.refundOnlyRun = refundRun
  evidence.checks.push('仅退款正式页面无寄回入口并显示已确认模拟业务结果')
  await page.screenshot({ path: `${root}/desktop-refund-only.png`, fullPage: true })
  assert.deepEqual(evidence.errors, [])
  console.log(JSON.stringify(evidence, null, 2))
} catch (error) {
  evidence.failure = String(error.stack)
  await page.screenshot({ path: `${root}/final-ui-failure.png`, fullPage: true })
  console.error(error)
  process.exitCode = 1
} finally {
  writeFileSync(`${root}/final-ui-evidence.json`, JSON.stringify(evidence, null, 2))
  await browser.close()
}
process.exit(process.exitCode ?? 0)
