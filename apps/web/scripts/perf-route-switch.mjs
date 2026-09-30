import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

// 等待身份确认后测量真实导航 不把缺失链接视为通过
const base = process.env.PERF_BASE ?? 'http://127.0.0.1:8790'
const executablePath =
  process.env.PERF_BROWSER ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync)
assert.ok(executablePath, '未找到浏览器 请设置 PERF_BROWSER')
const routes = [
  ['/approvals', '审批中心'],
  ['/policies', '知识与政策'],
  ['/eval', '评测看板'],
  ['/settings', '运行设置'],
  ['/console', '处理工作台'],
]
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-first-run'] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  const errors = []
  const requests = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('request', (request) => {
    const url = new URL(request.url())
    requests.push({
      path: url.pathname,
      rsc: url.searchParams.has('_rsc'),
      method: request.method(),
    })
  })
  await page.evaluateOnNewDocument(() => {
    window.__routePerf = { started: 0, feedback: null, tasks: [] }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime >= window.__routePerf.started)
          window.__routePerf.tasks.push(Math.round(entry.duration))
      }
    }).observe({ entryTypes: ['longtask'] })
    document.addEventListener(
      'click',
      (event) => {
        if (event.target.closest('a.youju-nav'))
          window.__routePerf = { started: performance.now(), feedback: null, tasks: [] }
      },
      true,
    )
    // 只观察导航反馈 不改变页面业务状态
    new window.MutationObserver(() => {
      const sample = window.__routePerf
      if (
        sample.started &&
        sample.feedback === null &&
        document.querySelector('[data-pending="true"]')
      ) {
        sample.feedback = Math.round(performance.now() - sample.started)
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-pending'],
    })
  })
  await page.goto(`${base}/console`, { waitUntil: 'load' })
  await page.waitForSelector('a.youju-nav[href="/approvals"]')
  await page.waitForSelector('#main-content h1')
  const rows = []
  for (let round = 1; round <= 3; round++) {
    for (const [route, title] of routes) {
      const shell = await page.$('.youju-sidebar')
      const offset = requests.length
      await page.click(`a.youju-nav[href="${route}"]`)
      // 加载占位不算切换完成 必须等目标内容实际渲染
      await page.waitForFunction(
        ({ route, title }) =>
          location.pathname === route &&
          document.querySelector('#main-content h1')?.textContent === title,
        { timeout: 30000 },
        { route, title },
      )
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      )
      const measurement = await page.evaluate(() => ({
        visualMs: Math.round(performance.now() - window.__routePerf.started),
        feedbackMs: window.__routePerf.feedback,
        longTasks: window.__routePerf.tasks,
      }))
      const shellPreserved = await shell.evaluate((element) => element.isConnected)
      await shell.dispose()
      await page.waitForNetworkIdle({ idleTime: 150, timeout: 10000 })
      const observed = requests.slice(offset)
      const row = {
        round,
        route,
        ...measurement,
        shellPreserved,
        routeRequests: observed.filter((request) => request.rsc).length,
        apiRequests: observed.filter(
          (request) => request.path.startsWith('/api/') && request.method === 'GET',
        ),
      }
      rows.push(row)
      console.log(JSON.stringify(row))
      assert.ok(shellPreserved, `${route} 不应重建公共导航`)
      assert.ok(
        row.apiRequests.filter((request) => request.path === '/api/eval/reports').length <= 1,
        '不应重复读取报告',
      )
    }
  }
  assert.deepEqual(errors, [], '页面不应产生运行时异常')
  if (process.env.PERF_OUTPUT) writeFileSync(process.env.PERF_OUTPUT, JSON.stringify(rows, null, 2))
  console.log('通过 路由可达 公共布局保留 报告请求去重 无页面运行时异常')
} finally {
  await browser.close()
}
