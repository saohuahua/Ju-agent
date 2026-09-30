import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deploymentSourceManifest,
  sourceIdentity,
  SourceIdentityError,
  contentHash,
} from '../src/p9-metadata.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'p10-manifest-'))
  for (const directory of ['packages', 'apps', 'scripts']) mkdirSync(join(root, directory))
  for (const file of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'eslint.config.js',
  ])
    writeFileSync(join(root, file), '{}')
  const code = join(root, 'packages/source.ts')
  writeFileSync(code, 'export const value = 1')
  const path = join(root, '.p10-source.json')
  const manifest = deploymentSourceManifest(root)
  writeFileSync(path, JSON.stringify(manifest))
  return { root, code, path, manifest }
}

it('构建目录无 Git 时以实际内容身份验证 不伪造提交状态', () => {
  const f = fixture()
  expect(sourceIdentity(f.root, f.path)).toEqual(f.manifest.source)
  expect(f.manifest.source).toMatchObject({ head: null, dirty: null })
  expect(() => sourceIdentity(f.root)).toThrow(SourceIdentityError)
})

it.each(['changed', 'missing', 'added', 'duplicate', 'escape', 'version', 'forged-head', 'hash'])(
  '内容或清单 %s 时拒绝来源声明',
  (mode) => {
    const f = fixture()
    if (mode === 'changed') writeFileSync(f.code, 'export const value = 2')
    if (mode === 'missing') unlinkSync(f.code)
    if (mode === 'added') writeFileSync(join(f.root, 'packages/new.ts'), 'export {}')
    if (mode === 'duplicate') f.manifest.source.files.push(f.manifest.source.files[0]!)
    if (mode === 'escape') f.manifest.source.files[0]!.path = '../outside'
    if (mode === 'version') f.manifest.schemaVersion = 2
    if (mode === 'hash') f.manifest.source.hash = 'forged'
    if (mode === 'forged-head')
      Object.assign(f.manifest.source, { head: 'fake-commit', dirty: false })
    // 重算自报哈希仍不能绕过与实际文件的逐项比较
    if (mode === 'duplicate' || mode === 'escape')
      f.manifest.source.hash = contentHash(f.manifest.source.files)
    writeFileSync(f.path, JSON.stringify(f.manifest))
    expect(() => sourceIdentity(f.root, f.path)).toThrow(SourceIdentityError)
  },
)
