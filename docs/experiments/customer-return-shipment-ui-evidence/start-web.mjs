import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
const root = 'C:/Users/htlocal/AppData/Local/Temp/customer-return-ui-20260926-124648'
const environment = JSON.parse(readFileSync(`${root}/browser-environment.json`, 'utf8'))
const server = createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise(resolve => server.close(resolve))
const env = Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'].map(key => [key, process.env[key] ?? '']))
const web = spawn(process.execPath, ['D:/project/agent-new/aftersales/apps/web/node_modules/next/dist/bin/next', 'dev', '-H', '127.0.0.1', '-p', String(port)], {
  cwd: 'D:/project/agent-new/.tmp-customer-return-ui-20260926/apps/web', env: { ...env, NEXT_PUBLIC_API_BASE: environment.apiUrl, NEXT_TELEMETRY_DISABLED: '1' }, windowsHide: true,
})
web.stdout.on('data', bytes => appendFileSync(`${root}/browser-web-same-drive.log`, bytes))
web.stderr.on('data', bytes => appendFileSync(`${root}/browser-web-same-drive.log`, bytes))
writeFileSync(`${root}/browser-environment.json`, JSON.stringify({ ...environment, oldWebPid: environment.webPid, webPid: web.pid, webUrl: `http://127.0.0.1:${port}`, webHelperPid: process.pid }, null, 2))
console.log(`http://127.0.0.1:${port}`)
process.on('SIGINT', () => { web.kill(); process.exit() })
