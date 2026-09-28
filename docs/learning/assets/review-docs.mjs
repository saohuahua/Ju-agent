import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

// 核对教材链接和结构并保存独立文档检查记录
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const learning = resolve(root, 'docs/learning')
const files = [
  'docs/interview/README.md', 'docs/interview/面经-有据售后.md', 'docs/interview/面经覆盖映射.md', 'docs/interview/简历事实摘要.md', 'docs/runbooks/p11-local-offline-demo.md',
  'docs/experiments/p11-learning-validation.md',
  'docs/handoffs/p11-learning-delivery.md',
  ...readdirSync(learning).filter(name => name.endsWith('.md')).map(name => 'docs/learning/' + name),
]
const missing = []
const anchors = []
const chapters = []
let links = 0
for (const file of files) {
  const raw = readFileSync(resolve(root, file), 'utf8')
  const prose = raw.replace(/```[\s\S]*?```/g, '')
  for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '')
    if (/^(https?:|mailto:|codex:)/.test(target)) continue
    links++
    const [path, fragment] = target.split('#')
    const destination = resolve(dirname(resolve(root, file)), decodeURIComponent(path || ''))
    if (!existsSync(destination)) missing.push({ file, target })
    else if (fragment && path.endsWith('.md')) {
      const content = readFileSync(destination, 'utf8')
      if (!content.includes(`id="${fragment}"`)) anchors.push({ file, target })
    }
  }
  if (/\/\d{2}-/.test(file)) {
    chapters.push({
      file, chineseCharacters: (prose.match(/[\p{Script=Han}]/gu) || []).length,
      figures: (prose.match(/!\[/g) || []).length,
      hasPrerequisite: raw.includes('阅读前提'),
      hasImplementation: /## .*思路|## 设计推导/.test(raw),
      hasSources: /\.\.\/\.\.\/packages|\.\.\/\.\.\/apps/.test(raw),
      hasExercise: raw.includes('渐进重建练习'),
    })
  }
}
const interview = readFileSync(resolve(root, 'docs/interview/面经-有据售后.md'), 'utf8')
const questions = [...interview.matchAll(/### (Q\d{2}) ([^\n]+)/g)].map(match => match[1])
const coverage = readFileSync(resolve(root, 'docs/interview/面经覆盖映射.md'), 'utf8')
const mapped = [...coverage.matchAll(/^\| (\d{2}) \|/gm)].map(match => match[1])
const selftest = readFileSync(resolve(learning, '集中自测.md'), 'utf8')
const selfQuestions = [...selftest.matchAll(/\*\*(\d{2}[AB])\*\*/g)].map(match => match[1])
const svg = readdirSync(resolve(learning, 'assets')).filter(name => name.endsWith('.svg'))
const report = {
  checkedAt: new Date().toISOString(), scope: 'P11 learning documents only',
  files: files.length, localLinks: links, missing, unresolvedExplicitAnchors: anchors,
  chapters, mainQuestions: questions, mappedQuestions: mapped, selfQuestions,
  svgFiles: svg,
  svgHashes: Object.fromEntries(svg.map(file => [file, createHash('sha256').update(readFileSync(resolve(learning, 'assets', file))).digest('hex')])),
  sourceHashes: Object.fromEntries([
    'packages/runtime/src/durable-conversation.ts', 'packages/runtime/src/p6-worker.ts',
    'packages/persistence/src/p6-task-repository.ts', 'packages/persistence/src/p7-ledger.ts',
    'packages/runtime/src/p8-investigation.ts', 'packages/domain/src/knowledge.ts',
    'packages/eval/src/metrics.ts', 'apps/api/src/sse.ts', 'docs/runbooks/p11-demo.ts',
  ].map(file => [file, createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex')])),
}
const demo = JSON.parse(readFileSync(resolve(root, 'docs/experiments/p11-learning-evidence/demo-summary-after-cleanup.json'), 'utf8'))
report.demoSourceComparison = Object.entries(demo.sourceHashes).map(([file, expected]) => ({
  file, expected, actual: createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex'),
})).map(item => ({ ...item, matches: item.expected === item.actual }))
const out = resolve(root, 'docs/experiments/p11-learning-evidence/document-check.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ files: report.files, localLinks: links, missing, anchors,
  chapters: chapters.length, mainQuestions: questions.length, mapped: mapped.length,
  selfQuestions: selfQuestions.length, svg: svg.length, chapterChecks: chapters }, null, 2))
if (missing.length || anchors.length || chapters.length !== 22 || questions.length !== 24 || mapped.length !== 40 || selfQuestions.length !== 44) process.exitCode = 1
