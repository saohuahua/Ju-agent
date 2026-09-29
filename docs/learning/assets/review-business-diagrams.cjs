const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// 浏览器工具不可用时使用已安装运行库复核独立图示
const playwright = require(process.argv[2] || 'playwright')
const base = path.resolve(__dirname, '..')
const requested = process.argv.slice(3)
const businessSpecs = JSON.parse(fs.readFileSync(path.join(__dirname,'business-diagram-specs.json'),'utf8'))
const specs = requested.length
  ? [...businessSpecs, ...JSON.parse(fs.readFileSync(path.join(__dirname,'diagram-specs.json'),'utf8'))].filter(spec=>requested.includes(spec.id))
  : businessSpecs
if (requested.some(id=>!specs.some(spec=>spec.id===id))) throw new Error('指定图示不存在')
const output = fs.mkdtempSync(path.join(os.tmpdir(),'aftersales-learning-'))
async function main() {
  const browser = await playwright.chromium.launch({channel:'chrome',headless:true})
  try {
    const page = await browser.newPage({viewport:{width:1180,height:1300},deviceScaleFactor:1})
    const results=[]
    for (const spec of specs) {
      const svg=fs.readFileSync(path.join(__dirname,spec.id+'.svg'),'utf8')
      await page.setContent('<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:20px;background:white}svg{display:block}</style>'+svg)
      await page.evaluate(()=>document.fonts.ready)
      const issues=await page.evaluate(spec=>{
        const issues=[]
        for(const el of document.querySelectorAll('text')) {
          const b=el.getBBox()
          if(b.x<0||b.y<0||b.x+b.width>1120||b.y+b.height>spec.height) issues.push({kind:'canvas-overflow',text:el.textContent})
          const x=Number(el.getAttribute('x'))
          const n=spec.nodes.find(n=>Math.abs(n.x+n.w/2-x)<.1 && b.y>=n.y && b.y<n.y+n.h)
          if(n && (b.x<n.x+4||b.x+b.width>n.x+n.w-4||b.y+b.height>n.y+n.h-4)) issues.push({kind:'node-overflow',node:n.title,text:el.textContent})
        }
        return issues
      },spec)
      const screenshot=path.join(output,spec.id+'.png')
      await page.locator('svg').screenshot({path:screenshot})
      results.push({id:spec.id,screenshot,issues})
    }
    const report={checkedAt:new Date().toISOString(),browser:'Chromium via installed Chrome',reason:'CUA kernel sandbox initialization failed',typoraVerified:false,results}
    fs.writeFileSync(path.join(base,'维护与证据',requested.length?'图示定向复核.json':'业务图示浏览器检查.json'),JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify(report,null,2))
    if(results.some(r=>r.issues.length))process.exitCode=1
  } finally { await browser.close() }
}
main().catch(error=>{console.error(error);process.exitCode=1})
