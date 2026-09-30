import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deploymentSourceManifest, projectRoot } from '../packages/eval/src/p9-metadata.js'

// 在最终构建上下文内生成清单 不调用 Git 或采集环境凭据
const root = resolve(process.argv[2] ?? projectRoot)
const manifest = deploymentSourceManifest(root)
writeFileSync(resolve(root, '.p10-source.json'), JSON.stringify(manifest, null, 2))
console.log(
  JSON.stringify({ sourceHash: manifest.source.hash, files: manifest.source.files.length }),
)
