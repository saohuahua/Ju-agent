import { openDatabase } from '../../../persistence/src/db.js'
import { migrateP6 } from '../../../persistence/src/p6-migration.js'
import { P6TaskRepository } from '../../../persistence/src/p6-task-repository.js'
import {
  p6ApprovalCommand,
  p6ApplyBusinessPayment,
  p6PrepareBusinessPayment,
} from '../../../persistence/src/p6-business-adapter.js'
import {
  p6PaymentClient,
  startP6PaymentSimulator,
} from '../../../persistence/src/p6-payment-simulator.js'
import { P6Worker } from '../../src/p6-worker.js'
import { ApprovalService, FrozenClock } from '@aftersales/domain'
import { SqliteApprovalRepository } from '../../../persistence/src/business-repositories.js'
import { ScriptedModel } from '@aftersales/agent'
import type { P6CommandInput, P6ConfigSnapshot } from '../../../contracts/src/p6-durable.js'

const [mode, path, scenario = 'normal', paymentUrl = ''] = process.argv.slice(2)
if (!mode || !path) throw new Error('缺少实验参数')
const db = openDatabase(path)
const log = (event: string, detail: unknown = null) => {
  console.log(JSON.stringify({ pid: process.pid, event, detail, time: new Date().toISOString() }))
  process.send?.({ event, detail })
}
const limits = { global: 2, customer: 1, provider: 2, tool: 2 }
const config: P6ConfigSnapshot = {
  snapshotId: 'scripted-frozen-v1',
  provider: 'scripted',
  model: 'scripted-v1',
  promptVersion: 'p6-v1',
  value: { scenario, paid: false },
}

if (mode === 'channel') {
  const server = await startP6PaymentSimulator(db)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('模拟渠道未监听')
  log('ready', { url: `http://127.0.0.1:${address.port}` })
} else {
  migrateP6(db)
  const repo = new P6TaskRepository(db)
  if (mode === 'accept' || mode === 'approval') {
    const input: P6CommandInput = {
      requestKey: scenario === 'new-run' ? 'request-2' : 'request-1',
      customerId: 'C1001',
      kind: 'start',
      config,
      source: 'sim',
      plan: {
        input: '验证持久恢复',
        tool: 'compensation',
        payment: {
          businessKey: 'compensation:CP-P6',
          resourceId: 'compensation:CP-P6',
          amountCents: 1000,
          currency: 'CNY',
        },
      },
    }
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO compensations (compensation_no,order_no,customer_id,reason,status,amount_cents,
      currency,channel,requires_approval,policy_version,created_at,updated_at) VALUES
      ('CP-P6','O-P6','C1001','logistics_delay',?,1000,'CNY','local-sim',?,'test',?,?)
      ON CONFLICT DO NOTHING`,
    ).run(
      mode === 'approval' ? 'awaiting_approval' : 'auto_approved',
      mode === 'approval' ? 1 : 0,
      now,
      now,
    )
    if (mode === 'accept') {
      const first = repo.accept(input)
      const duplicate = repo.accept(input)
      if (first.taskId !== duplicate.taskId) throw new Error('重复受理创建了新任务')
      log('accepted', { taskId: first.taskId, runId: first.runId })
    } else {
      db.prepare(
        `INSERT INTO agent_runs (run_id,customer_id,status,prompt_version,model,created_at,updated_at,source)
        VALUES ('run-approval','C1001','awaiting_approval','p6-v1','scripted-v1',?,?,'sim')`,
      ).run(now, now)
      const service = new ApprovalService(new SqliteApprovalRepository(db), new FrozenClock(now))
      const approval = await service.create({
        runId: 'run-approval',
        resourceType: 'compensation',
        resourceId: 'CP-P6',
        reason: '故障实验',
        amountCents: 1000,
        requestedBy: 'p6-test',
      })
      db.prepare(
        'INSERT INTO checkpoints(run_id,step_id,state_json,created_at) VALUES (?,?,?,?)',
      ).run(
        'run-approval',
        'approval',
        JSON.stringify({
          approvalId: approval.approvalId,
          compensationNo: 'CP-P6',
          amountCents: 1000,
          approvalResourceType: 'compensation',
        }),
        now,
      )
      const decision = await service.decide(
        { role: 'supervisor' },
        approval.approvalId,
        'approved',
        'run-approval',
      )
      if (decision.outcome !== 'decided') throw new Error('审批受理失败')
      log('approval-accepted', { approvalId: approval.approvalId })
    }
    // 强制退出不执行应用关闭钩子 验证提交后的磁盘事实独立于内存对象
    process.exit(73)
  } else if (mode === 'stale') {
    const claim = repo.claim(`old-${process.pid}`, 250, limits)
    if (!claim) throw new Error('旧 Worker 未能认领')
    log('old-claimed', claim)
    await new Promise<void>((resolve) => process.once('message', () => resolve()))
    let rejected = false
    try {
      repo.checkpoint(claim, 'stale-write', '禁止写入')
    } catch {
      rejected = true
    }
    log('old-returned', { rejected, renewed: repo.renew(claim, 1000) })
    db.close()
    process.disconnect?.()
  } else if (mode === 'worker') {
    if (scenario === 'competition') {
      log('worker-ready')
      await new Promise<void>((resolve) => process.once('message', () => resolve()))
    }
    repo.bridgeApprovals((id) => p6ApprovalCommand(db, id, config))
    const worker = new P6Worker(
      repo,
      {
        model: async (_input, snapshot, signal) => {
          signal.throwIfAborted()
          log('model-called', { snapshot })
          const script = new ScriptedModel([
            { kind: 'final', answer: '脚本模型完整结果', summary: '本地模拟', escalated: false },
          ])
          let text = ''
          let completed = false
          for await (const event of script.stream({ system: '', messages: [], tools: [] })) {
            if (event.type === 'text_delta') {
              text += event.text
              if (scenario === 'mid-stream') {
                log('partial-stream')
                process.exit(73)
              }
            }
            if (event.type === 'turn_completed') completed = true
          }
          if (!completed) throw new Error('模型流未完整结束')
          return { text, snapshotId: snapshot.snapshotId }
        },
        read: async (_task, signal) => {
          log('read-called')
          if (scenario === 'read-timeout' || scenario === 'long-read') {
            await new Promise<void>((_, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
            )
          }
          return { orderNo: 'O-P6', source: 'local-script' }
        },
        payment: p6PaymentClient(paymentUrl),
        applyPayment: p6ApplyBusinessPayment,
        preparePayment: p6PrepareBusinessPayment,
        boundary: async (name, task) => {
          log(name, { taskId: task.taskId, generation: task.generation })
          if (scenario === name) process.exit(73)
          if (scenario === 'cancel-after-send' && name === 'after-payment-response')
            repo.cancel(task.taskId, task.customerId)
          if (scenario === 'competition' && name === 'claimed')
            await new Promise((resolve) => setTimeout(resolve, 200))
        },
      },
      {
        owner: `worker-${process.pid}`,
        leaseMs: 300,
        callTimeoutMs: scenario === 'long-read' ? 5000 : 150,
        maxAttempts: 2,
        retryDelayMs: 0,
        limits,
      },
    )
    log('worker-result', { claimed: await worker.runOnce() })
    db.close()
    process.disconnect?.()
  } else throw new Error('未知实验进程模式')
}
