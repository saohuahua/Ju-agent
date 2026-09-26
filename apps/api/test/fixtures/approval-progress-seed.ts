import type { ComposedSystem } from '@aftersales/runtime'

/** 展示用状态快照明确标注评测 不模拟真实模型成绩或支付渠道能力 */
export async function seedApprovalProgress(system: ComposedSystem) {
  const snapshots = [
    { name: '待执行', execution: 'pending', business: 'approved' },
    { name: '执行中', execution: 'running', business: 'executing' },
    { name: '业务成功但调用失败', execution: 'failed', business: 'succeeded' },
    { name: '业务失败但调用结束', execution: 'completed', business: 'failed' },
    { name: '结果未知', execution: 'completed', business: 'unknown' },
    { name: '持久任务待核验', execution: 'running', business: 'executing' },
  ]
  for (const [index, snapshot] of snapshots.entries()) {
    const run = await system.runService.start({
      customerId: 'C1001',
      model: 'ui-fixture',
      promptVersion: 'progress-snapshot',
      source: 'sim',
    })
    await system.runService.emit(run.runId, 'message.user', {
      text: `执行进度验收快照 ${snapshot.name}`,
    })
    const resourceId = `CP-progress-fixture-${index}`
    const now = system.clock.now().toISOString()
    system.db
      .prepare(
        `INSERT INTO compensations
      (compensation_no, order_no, customer_id, reason, status, amount_cents, currency, channel, requires_approval, policy_version, created_at, updated_at)
      VALUES (?, 'SO-2026-0003', 'C1001', 'service_apology', ?, 100, 'CNY', 'mock', 1, 'fixture', ?, ?)`,
      )
      .run(resourceId, snapshot.business, now, now)
    const approval = await system.approvalService.create({
      runId: run.runId,
      resourceType: 'compensation',
      resourceId,
      amountCents: 100,
      reason: `测试快照 ${snapshot.name}`,
      requestedBy: 'fixture',
    })
    system.db
      .prepare("UPDATE approval_requests SET status = 'approved' WHERE approval_id = ?")
      .run(approval.approvalId)
    system.db
      .prepare(
        `INSERT INTO approval_execution_intents
      (approval_id, run_id, decision, decided_by, status, last_error, created_at, updated_at)
      VALUES (?, ?, 'approved', '验收主管', ?, ?, ?, ?)`,
      )
      .run(
        approval.approvalId,
        run.runId,
        snapshot.execution,
        snapshot.execution === 'failed' ? '验收异常' : null,
        now,
        now,
      )
    if (snapshot.name === '持久任务待核验') {
      // 构造持久任务状态用于页面验收 不启动 Worker 或发送资金
      const task = system.durableTasks.accept({
        requestKey: `fixture:${approval.approvalId}`,
        customerId: 'C1001',
        kind: 'approval',
        runId: run.runId,
        approvalId: approval.approvalId,
        source: 'sim',
        config: {
          snapshotId: 'ui-fixture',
          provider: 'fixture',
          model: 'ui-fixture',
          promptVersion: 'progress-snapshot',
          value: {},
        },
        plan: { input: '待核验展示', tool: 'compensation' },
      })
      system.db
        .prepare("UPDATE p6_tasks SET status = 'needs_confirmation' WHERE task_id = ?")
        .run(task.taskId)
    }
  }
}
