import { createServer } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 只向本机提供教材图示预览
const directory = dirname(fileURLToPath(import.meta.url))
const names = readdirSync(directory).filter(name => name.endsWith('.svg')).sort()
const specs = [
  ...JSON.parse(readFileSync(join(directory, 'diagram-specs.json'), 'utf8')),
  ...JSON.parse(readFileSync(join(directory, 'business-diagram-specs.json'), 'utf8')),
]
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  const start = Math.max(0, Number(url.searchParams.get('start') || 0))
  const count = Math.min(30, Math.max(1, Number(url.searchParams.get('count') || names.length)))
  const selected = names.slice(start, start + count)
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>P11 图示复核</title>
    <style>body{margin:0;padding:20px;background:#e5eaee;font-family:'Microsoft YaHei',sans-serif}h1{font-size:20px;color:#253b49}main{display:grid;grid-template-columns:repeat(2,560px);gap:20px}article{background:white;padding:12px;border-radius:12px}h2{font-size:14px;margin:0 0 10px}svg{width:100%;height:auto;display:block}body.single main{grid-template-columns:900px}</style>
    <body class="${count === 1 ? 'single' : ''}"><h1>P11 教材图示复核 · ${start + 1}–${start + selected.length} / ${names.length}</h1><main>${selected.map(name => `<article data-file="${name}"><h2>${name}</h2>${readFileSync(join(directory, name), 'utf8')}</article>`).join('')}</main>
    <script type="application/json" id="diagram-specs">${JSON.stringify(specs)}</script></body></html>`)
})
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/`))
