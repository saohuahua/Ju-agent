import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedModel } from '@aftersales/agent'
import { FrozenClock, KeywordPolicyScorer } from '@aftersales/domain'
import { composeSystem, BASELINE_FROZEN_TIME } from '@aftersales/runtime'
import { sourceIdentity } from '../../../packages/eval/src/p9-metadata.js'
import { createApp } from '../src/app.js'

const systems: ReturnType<typeof composeSystem>[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const system of systems.splice(0)) system.db.close()
})

function setup() {
  const system = composeSystem({
    clock: new FrozenClock(BASELINE_FROZEN_TIME),
    model: new ScriptedModel([]),
    policyScorer: new KeywordPolicyScorer(),
  })
  systems.push(system)
  const app = createApp({ system, modelAvailable: false })
  const directory = mkdtempSync(join(tmpdir(), 'p10-source-http-'))
  const manifest = join(directory, 'source.json')
  const source = {
    ...sourceIdentity(),
    head: null,
    dirty: null,
    completeness: 'verified-deployment-content-manifest',
  }
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, kind: 'deployment', source }))
  vi.stubEnv('P9_SOURCE_MANIFEST', manifest)
  // 仅当前测试隔离环境缺少 Git 不修改原仓库
  vi.stubEnv('GIT_DIR', join(directory, 'absent.git'))
  const run = () =>
    app.request('/api/eval/run', {
      method: 'POST',
      headers: { Authorization: 'Bearer operator-token' },
    })
  return { system, run, source, manifest }
}

it('无 Git 的正式 L1 HTTP 入口使用部署清单并持久保存可核验来源', async () => {
  const f = setup()
  const response = await f.run()
  expect(response.status).toBe(200)
  const record = f.system.db.prepare('SELECT evidence_json FROM eval_budget_evidence').get() as {
    evidence_json: string
  }
  const evidence = JSON.parse(record.evidence_json)
  expect(evidence.metadata.source).toEqual(f.source)
  expect(evidence.cases).toHaveLength(124)
  expect(evidence.cases.every((item: { passed: boolean }) => item.passed)).toBe(true)
  expect(evidence.costs.selection.summary.settled.count).toBe(339)
}, 60000)

it.each(['missing', 'corrupt'] as const)('部署清单 %s 时明确拒绝且不调用模型', async (mode) => {
  const f = setup()
  if (mode === 'missing') vi.stubEnv('P9_SOURCE_MANIFEST', `${f.manifest}.absent`)
  else writeFileSync(f.manifest, '{"schemaVersion":1,"kind":"deployment","source":{}}')
  const response = await f.run()
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: 'SOURCE_IDENTITY_UNAVAILABLE' })
  expect(f.system.db.prepare('SELECT COUNT(*) n FROM p7_calls').get()).toEqual({ n: 0 })
  expect(f.system.db.prepare('SELECT COUNT(*) n FROM eval_reports').get()).toEqual({ n: 0 })
})
