import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EvalCase } from '@aftersales/contracts'
import { POLICY_VERSION } from '@aftersales/domain'
import { BASELINE_FIXTURE } from '@aftersales/persistence'
import { EVAL_CASES } from './cases.js'
import { redactEvidence } from './p9-evidence.js'

// 对象键排序但保留数组顺序以固定样本身份
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

// 仅读取代码及构建配置白名单 不读取环境文件和产物目录
export function sourceIdentity(root = projectRoot) {
  const paths: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      if (
        entry.isSymbolicLink() ||
        entry.name.startsWith('.') ||
        ['node_modules', 'dist', 'coverage', 'data'].includes(entry.name)
      )
        continue
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else if (
        /\.(?:ts|tsx|js|mjs|json|yaml)$/.test(entry.name) &&
        !entry.name.includes('tsbuildinfo')
      )
        paths.push(path)
    }
  }
  for (const dir of ['packages', 'apps', 'scripts']) walk(dir)
  paths.push(
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'eslint.config.js',
  )
  const files = [...new Set(paths)].sort().map((path) => ({
    path,
    sha256: createHash('sha256')
      .update(readFileSync(resolve(root, path)))
      .digest('hex'),
  }))
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  return {
    head: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain', '--untracked-files=all').length > 0,
    scope:
      'packages apps scripts 中代码与 JSON YAML 配置 以及根依赖锁和工具配置 排除隐藏目录与产物',
    files,
    hash: contentHash(files),
    completeness: 'bounded-content-manifest-not-clean-head',
  }
}

export function evaluationMetadata(cases: EvalCase[], repeat: number, level: 'L1' | 'L2') {
  const selectedCases = redactEvidence(cases)
  return {
    schemaVersion: 1 as const,
    mode: 'deterministic-offline' as const,
    metricVersion: 'p9-v1',
    level,
    datasetHash: contentHash(EVAL_CASES),
    selectedHash: contentHash(selectedCases),
    selectedCases,
    caseOrder: cases.map((item) => item.id),
    repeat,
    policyVersion: POLICY_VERSION,
    knowledgeHash: contentHash(BASELINE_FIXTURE.policyArticles),
    fixtureHash: contentHash(BASELINE_FIXTURE),
    source: sourceIdentity(),
    judgeCalibration: 'not_calibrated_no_real_human_labels_or_judge_outputs',
  }
}

export type P9Metadata = ReturnType<typeof evaluationMetadata>

// 限定导出相对路径阻止证据定位逃逸
export function evidencePath(directory: string, file: string): string {
  const path = resolve(directory, file)
  const rel = relative(resolve(directory), path)
  if (
    !rel ||
    rel.startsWith('..') ||
    resolve(directory) === path ||
    /[:\\]/.test(file) ||
    file.startsWith('/')
  )
    throw new Error('证据路径越界')
  return path
}
