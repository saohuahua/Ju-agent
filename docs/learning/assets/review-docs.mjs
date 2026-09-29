import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { resolve, dirname, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

// 递归核对当前教材 不覆盖历史实验输出
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const learning = resolve(root, 'docs/learning')
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.git', '.next', 'dist', '.agents', '.codex'].includes(entry.name)) return []
    const file = resolve(dir, entry.name)
    return entry.isDirectory() ? walk(file) : entry.name.endsWith('.md') ? [file] : []
  })
}
const local = file => relative(root, file).replaceAll('\\', '/')
const files = walk(root).filter(file => !/[\\/]docs[\\/]experiments[\\/].*evidence[\\/]/.test(file))
const missing = [], unresolvedAnchors = [], chapters = [], business = []
let links = 0
const stripCode = raw => raw.replace(new RegExp('\x60\x60\x60[\\s\\S]*?\x60\x60\x60', 'g'), '')
function anchorExists(file, fragment) {
  const content = stripCode(readFileSync(file, 'utf8'))
  if (content.includes('id="' + fragment + '"')) return true
  const seen = new Map()
  return [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].some(match => {
    const plain = match[1].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/<[^>]*>/g, '')
    const slug = plain.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-')
    const count = seen.get(slug) || 0
    seen.set(slug, count + 1)
    return fragment === slug + (count ? '-' + count : '')
  })
}
for (const file of files) {
  const raw = readFileSync(file, 'utf8'), prose = stripCode(raw)
  for (const match of prose.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '')
    if (/^(https?:|mailto:|codex:|data:)/.test(target)) continue
    links++
    const [part, fragment] = target.split('#')
    const destination = part ? resolve(dirname(file), decodeURIComponent(part)) : file
    if (!existsSync(destination)) missing.push({ file: local(file), target })
    else if (fragment && destination.endsWith('.md') && !anchorExists(destination, decodeURIComponent(fragment)))
      unresolvedAnchors.push({ file: local(file), target })
  }
  if (file.startsWith(learning) && /^(\d{2}|B\d{2})-/.test(basename(file))) {
    const item = {
      file: local(file), chineseCharacters: (prose.match(/\p{Script=Han}/gu) || []).length,
      figures: (prose.match(/!\[/g) || []).length,
      hasPrerequisite: raw.includes('阅读前提'),
      hasImplementation: /## .*思路|## 设计推导/.test(raw),
      hasSources: /\]\((?:\.\.\/)+(?:packages|apps)\//.test(raw),
      headingDepthValid: !/^#{4,}\s/m.test(prose),
    }
    ;(basename(file).startsWith('B') ? business : chapters).push(item)
  }
}
const exercise = readFileSync(resolve(learning, '09-练习与自测/业务流程练习.md'), 'utf8')
const answers = readFileSync(resolve(learning, '09-练习与自测/业务流程练习解析.md'), 'utf8')
const questionIds = [...exercise.matchAll(/\*\*(B\d{2}[A-Z])\*\*/g)].map(m => m[1])
const answerIds = [...answers.matchAll(/\*\*(B\d{2}[A-Z])\*\*/g)].map(m => m[1])
const originalSelfQuestions = [...readFileSync(resolve(learning,'09-练习与自测/集中自测.md'),'utf8').matchAll(/\*\*(\d{2}[AB])\*\*/g)].map(m=>m[1])
const specs = JSON.parse(readFileSync(resolve(learning, 'assets/business-diagram-specs.json'), 'utf8'))
const diagramIssues = []
for (const spec of specs) {
  if (!existsSync(resolve(learning, 'assets', spec.id + '.svg'))) diagramIssues.push(spec.id + ':missing')
  for (const n of spec.nodes) if (n.x < 0 || n.y < 95 || n.x+n.w > 1120 || n.y+n.h > spec.height-45)
    diagramIssues.push(spec.id + ':bounds:' + n.title)
}
const sourceFiles = [
  'packages/domain/src/policy.ts', 'packages/domain/src/services/after-sale-service.ts',
  'packages/domain/src/services/compensation-service.ts', 'packages/domain/src/services/price-protection-service.ts',
  'packages/domain/src/services/rating-service.ts', 'packages/domain/src/services/logistics-event-service.ts',
  'packages/domain/src/case-closure.ts', 'packages/persistence/src/case-closure-repository.ts',
  'packages/persistence/src/conversation-journal.ts', 'packages/persistence/src/p6-conversation-refund.ts',
  'packages/runtime/src/durable-business.ts', 'apps/api/src/app.ts', 'apps/api/src/customer-progress.ts',
  'packages/runtime/src/durable-conversation.ts', 'packages/runtime/src/customer-guidance.ts',
]
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const report = {
  checkedAt: new Date().toISOString(), scope: 'Current maintainable Markdown links and learning structure',
  files: files.length, localLinks: links, missing, unresolvedAnchors, chapters, business,
  businessQuestions: questionIds, businessAnswers: answerIds, originalSelfQuestions, diagrams: specs.length, diagramIssues,
  sourceHashes: Object.fromEntries(sourceFiles.map(file => [file, hash(resolve(root,file))])),
  svgHashes: Object.fromEntries(specs.map(s => [s.id + '.svg', hash(resolve(learning,'assets',s.id+'.svg'))])),
  limitations: ['未运行应用构建与业务测试', 'SVG 静态边界检查不代替视觉预览', '未验证 Typora 实际显示', '历史实验原始输出未改写'],
}
const structural = chapters.length!==22 || business.length!==10 || questionIds.length!==23 || JSON.stringify(questionIds)!==JSON.stringify(answerIds) || specs.length!==10 || originalSelfQuestions.length!==44
const checks = business.filter(c => !c.hasPrerequisite || !c.hasImplementation || !c.hasSources || !c.headingDepthValid || !c.figures)
// 其他历史文档的问题保留报告 不冒充本次教材迁移引入
const affected = item => item.file.startsWith('docs/learning/') || item.target.includes('learning/')
const blockingMissing = missing.filter(affected)
const blockingAnchors = unresolvedAnchors.filter(affected)
report.blockingMissing = blockingMissing
report.blockingAnchors = blockingAnchors
report.unrelatedMissing = missing.filter(item => !affected(item))
writeFileSync(resolve(learning,'维护与证据/业务篇文档检查.json'), JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({files:files.length,localLinks:links,blockingMissing,blockingAnchors,unrelatedMissing:report.unrelatedMissing.length,chapters:chapters.length,business:business.length,questions:questionIds.length,originalSelfQuestions:originalSelfQuestions.length,diagrams:specs.length,diagramIssues,checks,structural,businessLengths:business.map(c=>({file:c.file,han:c.chineseCharacters}))},null,2))
if (blockingMissing.length || blockingAnchors.length || structural || diagramIssues.length || checks.length) process.exitCode=1
