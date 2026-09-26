import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { writeFileSync, appendFileSync } from 'node:fs'
import { openDatabase, loadFixture, startP6PaymentSimulator } from 'file:///D:/project/agent-new/aftersales/packages/persistence/src/index.ts'

const root = 'C:/Users/htlocal/AppData/Local/Temp/customer-return-ui-20260926-124648'
const repo = 'D:/project/agent-new/aftersales'
const db = openDatabase(`${root}/browser-application.db`)
loadFixture(db, [])
// 只调整基础订单夹具 业务必须从客户网页发起
db.prepare("UPDATE orders SET total_amount_cents = 699900, status = 'delivered', shipped_at = ?, delivered_at = ? WHERE order_no = 'SO-2026-0001'").run(new Date().toISOString(), new Date().toISOString())
db.close()
const channel = openDatabase(`${root}/browser-channel.db`)
const payment = await startP6PaymentSimulator(channel)
const paymentUrl = `http://127.0.0.1:${(payment.address() as { port: number }).port}`
const env = Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'].map(key => [key, process.env[key] ?? '']))
const api = spawn(process.execPath, ['--import', `file:///${repo}/node_modules/tsx/dist/loader.mjs`, `${repo}/apps/api/src/main.ts`], {
  cwd: root, env: { ...env, DB_PATH: `${root}/browser-application.db`, API_PORT: '0', P6_BUSINESS_MODE: 'simulation', P6_PAYMENT_SIMULATOR_URL: paymentUrl }, windowsHide: true,
})
const apiUrl = await new Promise<string>((resolve, reject) => {
  api.stdout!.on('data', bytes => {
    const text = String(bytes)
    appendFileSync(`${root}/browser-api.log`, text)
    const url = text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
    if (url) resolve(url)
  })
  api.stderr!.on('data', bytes => appendFileSync(`${root}/browser-api.log`, bytes))
  api.once('exit', code => reject(new Error(`API exit ${code}`)))
})
const portServer = createServer()
await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve))
const port = (portServer.address() as { port: number }).port
await new Promise<void>(resolve => portServer.close(() => resolve()))
const web = spawn(process.execPath, [`${repo}/apps/web/node_modules/next/dist/bin/next`, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
  cwd: `${root}/apps/web`, env: { ...env, NEXT_PUBLIC_API_BASE: apiUrl, NEXT_TELEMETRY_DISABLED: '1' }, windowsHide: true,
})
web.stdout!.on('data', bytes => appendFileSync(`${root}/browser-web.log`, bytes))
web.stderr!.on('data', bytes => appendFileSync(`${root}/browser-web.log`, bytes))
writeFileSync(`${root}/browser-environment.json`, JSON.stringify({ apiUrl, webUrl: `http://127.0.0.1:${port}`, paymentUrl, apiPid: api.pid, webPid: web.pid, helperPid: process.pid }, null, 2))
console.log(JSON.stringify({ apiUrl, webUrl: `http://127.0.0.1:${port}`, paymentUrl }))
// 仅关闭本次创建的子进程
process.on('SIGINT', () => { api.kill(); web.kill(); payment.close(); channel.close(); process.exit() })
