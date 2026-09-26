import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

// 测试探针阻止读取环境文件或发起模型网络请求
const probePath = process.env.P7_ENTRY_PROBE_PATH
fs.writeFileSync(probePath, '')
function record(kind) {
  fs.appendFileSync(probePath, JSON.stringify({ kind }) + '\n')
}
function check(file) {
  if (/(^|[\\/])\.env(?:\.[^\\/]*)?$/.test(String(file))) {
    record('environment-file')
    throw new Error('测试禁止读取环境文件')
  }
}
for (const name of ['readFileSync', 'existsSync', 'readFile']) {
  const original = fs[name]
  fs[name] = function (file, ...args) {
    check(file)
    return original.call(this, file, ...args)
  }
}
const readFile = fs.promises.readFile
fs.promises.readFile = async function (file, ...args) {
  check(file)
  return readFile.call(this, file, ...args)
}
syncBuiltinESMExports()
// 旧供应商适配器使用独立 node fetch 同时覆盖其底层请求入口
for (const transport of [http, https]) {
  for (const name of ['request', 'get']) {
    transport[name] = function () {
      record('model-network')
      throw new Error('测试禁止模型网络请求')
    }
  }
}
syncBuiltinESMExports()
const fetch = globalThis.fetch
globalThis.fetch = async function (input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/payments') {
    record('model-network')
    throw new Error('测试禁止模型网络请求')
  }
  return fetch(input, init)
}
