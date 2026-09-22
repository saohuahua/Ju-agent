/**
 * 满意度评分服务不变量测试
 *
 * 覆盖 仅终态可评 仅本人可评 一 run 一评幂等拒绝 分数区间 审计留痕
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { RatingService } from '../src/services/rating-service.js'
import { RunService } from '../src/services/run-service.js'
import { AuditService } from '../src/services/audit-service.js'
import { FrozenClock } from '../src/clock.js'
import { createInMemoryRepositories } from '../src/testing.js'

const BASE_TIME = '2026-09-20T12:00:00.000Z'

function setup() {
  const repos = createInMemoryRepositories()
  const clock = new FrozenClock(BASE_TIME)
  const audit = new AuditService(repos.auditRepo, clock)
  const runs = new RunService(repos.runRepo, repos.eventRepo, clock)
  const service = new RatingService(runs, repos.ratingRepo, audit, clock)
  return { repos, clock, runs, service, audit }
}

const customer = { role: 'customer' as const, customerId: 'C1001' }
const otherCustomer = { role: 'customer' as const, customerId: 'C1002' }
const operator = { role: 'operator' as const }

async function seedRun(ctx: ReturnType<typeof setup>, status: string) {
  const run = await ctx.runs.start({
    customerId: 'C1001',
    promptVersion: 'v2.1',
    model: 'scripted',
    source: 'customer',
  })
  await ctx.repos.runRepo.update({
    ...run,
    status: status as never,
    intent: null,
    error: null,
  })
  return ctx.repos.runRepo.findById(run.runId)
}

describe('满意度评分', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup()
  })

  it('终态会话客户评分成功 审计留痕', async () => {
    const run = await seedRun(ctx, 'completed')
    const rating = await ctx.service.submit(customer, run!.runId, { score: 5, comment: ' 很快 ' })
    expect(rating.score).toBe(5)
    expect(rating.comment).toBe('很快')
    const found = await ctx.service.findByRunId(run!.runId)
    expect(found?.score).toBe(5)
    const audits = await ctx.repos.auditRepo.listByRunId(run!.runId)
    expect(audits.some((entry) => entry.action === 'run_rated')).toBe(true)
  })

  it('进行中会话评分被拒', async () => {
    const run = await seedRun(ctx, 'running')
    await expect(
      ctx.service.submit(customer, run!.runId, { score: 4 }),
    ).rejects.toMatchObject({ shape: { code: 'CONFLICT' } })
    expect(await ctx.service.findByRunId(run!.runId)).toBeNull()
  })

  it('一 run 一评 重复提交幂等拒绝', async () => {
    const run = await seedRun(ctx, 'completed')
    await ctx.service.submit(customer, run!.runId, { score: 5 })
    await expect(
      ctx.service.submit(customer, run!.runId, { score: 3 }),
    ).rejects.toMatchObject({ shape: { code: 'CONFLICT' } })
    const found = await ctx.service.findByRunId(run!.runId)
    expect(found?.score).toBe(5)
  })

  it('操作员与他人会话不可评', async () => {
    const run = await seedRun(ctx, 'completed')
    await expect(ctx.service.submit(operator, run!.runId, { score: 5 })).rejects.toMatchObject({
      shape: { code: 'AUTHORIZATION_DENIED' },
    })
    await expect(
      ctx.service.submit(otherCustomer, run!.runId, { score: 5 }),
    ).rejects.toMatchObject({ shape: { code: 'AUTHORIZATION_DENIED' } })
  })

  it('分数须为 1 到 5 的整数', async () => {
    const run = await seedRun(ctx, 'completed')
    await expect(ctx.service.submit(customer, run!.runId, { score: 0 })).rejects.toMatchObject({
      shape: { code: 'VALIDATION_ERROR' },
    })
    await expect(ctx.service.submit(customer, run!.runId, { score: 6 })).rejects.toMatchObject({
      shape: { code: 'VALIDATION_ERROR' },
    })
    await expect(ctx.service.submit(customer, run!.runId, { score: 4.5 })).rejects.toMatchObject({
      shape: { code: 'VALIDATION_ERROR' },
    })
  })

  it('升级与人工处理中的会话也可评 全终态口径', async () => {
    const escalated = await seedRun(ctx, 'escalated')
    const rating = await ctx.service.submit(customer, escalated!.runId, { score: 2, comment: '没解决' })
    expect(rating.score).toBe(2)
  })
})
