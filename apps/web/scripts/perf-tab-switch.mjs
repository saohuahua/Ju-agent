/**
 * 切页性能实测脚本(真实浏览器)
 *
 * 用法: node scripts/perf-tab-switch.mjs
 * 环境变量: PERF_BASE(默认 http://localhost:8790) PERF_BROWSER(默认 Chrome)
 *
 * 测三类信号:
 * 1. 整页加载: goto 每个路由的耗时 + DOMContentLoaded/FCP
 * 2. 站内点击切换: click → URL 变化 → 双 rAF 视觉提交
 * 3. 每次切换期间的长任务(>50ms)与网络请求数
 * 另外检测切换是否退化成整页刷新(页面级随机令牌是否丢失)
 */

import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'

const BASE = process.env.PERF_BASE ?? 'http://localhost:8790'
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]
const BROWSER = process.env.PERF_BROWSER ?? CANDIDATES.find((p) => existsSync(p))
if (!BROWSER) {
  console.error('未找到 Chrome/Edge 请用 PERF_BROWSER 指定路径')
  process.exit(1)
}

const ROUTES = ['/workbench', '/approvals', '/runs', '/eval']
const ms = (v) => `${Math.round(v)}ms`.padStart(7)

const browser = await puppeteer.launch({
  executablePath: BROWSER,
  headless: true,
  args: ['--no-first-run', '--disable-extensions', '--disable-background-timer-throttling'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })

// ---------- 1. 整页加载 ----------

console.log('=== 整页加载(硬加载) ===')
for (const route of ROUTES) {
  const t0 = Date.now()
  await page.goto(`${BASE}${route}`, { waitUntil: 'load', timeout: 120000 })
  const wall = Date.now() - t0
  const nav = await page.evaluate(() => {
    const entry = performance.getEntriesByType('navigation')[0]
    const fcp = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint')
    return {
      domContentLoaded: entry?.domContentLoadedEventEnd ?? 0,
      loadEvent: entry?.loadEventEnd ?? 0,
      fcp: fcp?.startTime ?? -1,
      jsBytes: performance
        .getEntriesByType('resource')
        .filter((r) => r.name.includes('/_next/') && r.name.endsWith('.js'))
        .reduce((sum, r) => sum + (r.transferSize || 0), 0),
      jsRequests: performance
        .getEntriesByType('resource')
        .filter((r) => r.name.includes('/_next/') && r.name.endsWith('.js')).length,
    }
  })
  console.log(
    `${route.padEnd(11)} goto ${ms(wall)}  DCL ${ms(nav.domContentLoaded)}  FCP ${ms(nav.fcp)}  JS请求 ${nav.jsRequests} 个`,
  )
}

// ---------- 2. 站内点击切换(2 轮) ----------

console.log('=== 站内点击切换 click→视觉提交 ===')
for (let round = 1; round <= 2; round++) {
  for (const route of ROUTES) {
    await page.goto(`${BASE}/workbench`, { waitUntil: 'load' })
    // 页面级令牌 整页刷新会丢失 这里只做写入 不需要读回
    await page.evaluate(() => {
      window.__perfToken = 'alive'
    })
    const result = await page.evaluate(
      (target) =>
        new Promise((resolve) => {
          const t0 = performance.now()
          const link = document.querySelector(`a[href="${target}"]`)
          if (!link) {
            resolve({ error: 'nav link not found' })
            return
          }
          const longTasks = []
          const observer = new PerformanceObserver((list) => {
            for (const task of list.getEntries()) longTasks.push(Math.round(task.duration))
          })
          observer.observe({ entryTypes: ['longtask'] })
          link.click()
          const check = () => {
            if (location.pathname === target) {
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  observer.disconnect()
                  resolve({
                    elapsed: performance.now() - t0,
                    longTasks,
                    tokenLost: window.__perfToken !== 'alive',
                  })
                }),
              )
            } else if (performance.now() - t0 > 60000) {
              observer.disconnect()
              resolve({ error: 'timeout 60s' })
            } else {
              requestAnimationFrame(check)
            }
          }
          requestAnimationFrame(check)
        }),
      route,
    )
    if (result.error) {
      console.log(`轮${round} → ${route.padEnd(11)} 失败: ${result.error}`)
      continue
    }
    const reloadFlag = result.tokenLost ? '  ⚠ 整页刷新!' : ''
    const tasks = result.longTasks.length > 0 ? `  长任务 ${result.longTasks.length} 个(最长 ${Math.max(...result.longTasks)}ms)` : ''
    console.log(`轮${round} → ${route.padEnd(11)} ${ms(result.elapsed)}${reloadFlag}${tasks}`)
  }
}

await browser.close()
console.log('完成')
