import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// 复用仓库已有浏览器依赖 只测试本机真实容器服务
const base = process.argv[2] ?? 'http://127.0.0.1:28790'
assert.equal(new URL(base).hostname, '127.0.0.1')
const target = resolve(process.argv[3] ?? 'artifacts/p10-browser')
mkdirSync(target, { recursive: true })
const executablePath =
  process.env.P10_BROWSER_EXECUTABLE ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((path) => existsSync(path))
if (!executablePath) throw new Error('未找到浏览器 请显式提供 P10_BROWSER_EXECUTABLE')
const browser = await puppeteer.launch({ executablePath, headless: true })
const errors: string[] = []
try {
  const page = await browser.newPage()
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.setViewport({ width: 1440, height: 1000 })
  await page.goto(`${base}/workbench`, { waitUntil: 'networkidle2' })
  assert.match(await page.title(), /有据/)
  await page.waitForSelector('#demo-identity')
  await page.select('#demo-identity', 'cust-token-1001')
  await page.waitForSelector('#customer-message:not([disabled])')
  const created = page.waitForResponse(
    (response) => response.url() === `${base}/api/runs` && response.request().method() === 'POST',
  )
  const streamed = page.waitForResponse(
    (response) =>
      response.url().startsWith(`${base}/api/runs/`) &&
      response.headers()['content-type']?.includes('text/event-stream') === true,
  )
  await page.type('#customer-message', '请查询 SO-2026-0001')
  await page.keyboard.press('Enter')
  assert.equal((await created).status(), 202)
  assert.equal((await streamed).status(), 200)
  await page.waitForFunction(() => document.body.innerText.includes('演示查询已完成'))
  await page.screenshot({ path: join(target, 'browser-desktop.png'), fullPage: true })
  await page.setViewport({ width: 390, height: 844 })
  await page.screenshot({ path: join(target, 'browser-mobile.png'), fullPage: true })
  assert.deepEqual(errors, [])
  writeFileSync(
    join(target, 'browser.json'),
    JSON.stringify(
      {
        status: 'passed',
        url: page.url(),
        title: await page.title(),
        api: 'same-origin',
        sse: 'same-origin',
        errors,
      },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
}
