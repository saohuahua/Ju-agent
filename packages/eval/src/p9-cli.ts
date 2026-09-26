import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compareQualityBundles, verifyQualityBundle, type ExperimentVariable } from './p9-report.js'

// 比较入口只读取归档 不构造模型或数据库
const [command, left, right, output, declared = ''] = process.argv.slice(2)
try {
  if (command === 'verify' && left) {
    const result = verifyQualityBundle(resolve(left))
    console.log(JSON.stringify({ verified: true, cases: result.cases.length }))
  } else if (command === 'compare' && left && right && output) {
    const variables = declared ? declared.split(',') : []
    if (variables.some((item) => !['model', 'prompt', 'fault'].includes(item)))
      throw new Error('实验变量只允许 model prompt fault')
    const result = compareQualityBundles(
      resolve(left),
      resolve(right),
      variables as ExperimentVariable[],
    )
    mkdirSync(resolve(output), { recursive: true })
    writeFileSync(resolve(output, 'comparison.json'), JSON.stringify(result, null, 2))
    writeFileSync(
      resolve(output, 'comparison.md'),
      `# P9 报告对比\n\n${result.comparable ? '可比较的离线机制实验' : '不可比 拒绝计算差异'}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`,
    )
    console.log(JSON.stringify(result))
    if (!result.comparable) process.exitCode = 2
  } else
    throw new Error('用法 p9-cli verify 证据目录 或 compare 左目录 右目录 输出目录 可选变量列表')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
}
