import {
  INTENT_SLOT_SCHEMAS,
  receiveGoodsIdempotencyKey,
  refundIdempotencyKey,
} from '@aftersales/contracts'
import type { P6Payment, P6Task } from '@aftersales/contracts'
import {
  assertReturnTransition,
  type AfterSaleService,
  type ApprovalService,
} from '@aftersales/domain'
import type { SqliteDatabase } from './db.js'
import { P6TaskRepository } from './p6-task-repository.js'
import { ConversationJournal } from './conversation-journal.js'
import { ExecutionOwnershipRepository } from './execution-ownership-repository.js'
import { P6OwnedAfterSale } from './p6-owned-after-sale.js'
import { p6ReadyPayment } from './p6-business-adapter.js'
import {
  SqliteOrderRepository,
  SqliteShipmentRepository,
  SqliteReturnRepository,
  SqliteRefundRepository,
  SqliteApprovalRepository,
} from './business-repositories.js'

interface Link {
  run_id: string
  origin_task_id: string
  step_key: string
  tool_call_id: string
  tool_name: string
  return_no: string
  approval_id: string | null
  authorization_task_id: string | null
  binding_json: string
  projected: number
}

/** 原动作与业务授权一一关联 不从模型文字或悬空工具数量推断 */
export class P6ConversationRefundRepository {
  private readonly tasks: P6TaskRepository
  private readonly journal: ConversationJournal
  constructor(private readonly db: SqliteDatabase) {
    this.tasks = new P6TaskRepository(db)
    this.journal = new ConversationJournal(db, this.tasks)
  }

  link(runId: string): Link | undefined {
    return this.db.prepare('SELECT * FROM p6_conversation_refunds WHERE run_id = ?').get(runId) as
      Link | undefined
  }

  /** 围栏内重查事实 建单与授权及任务全部提交或全部回滚 */
  submit(
    task: P6Task,
    step: string,
    call: { toolCallId: string; toolName: string; input: Record<string, unknown> },
    services: { afterSale: AfterSaleService; approvals: ApprovalService },
  ): void {
    this.tasks.fenced(task, () => {
      const current = this.tasks.assertOwned(task)
      if (current.cancelRequested || current.deadline <= Date.now())
        throw new Error('动作已取消或超时')
      const run = this.db
        .prepare('SELECT status FROM agent_runs WHERE run_id = ?')
        .get(task.runId) as { status: string }
      if (run.status !== 'running' || this.link(task.runId))
        throw new Error('会话已接管或存在原退款流程')
      const name = call.toolName
      if (name !== 'submit_refund_only' && name !== 'submit_return')
        throw new Error('此动作未迁移 请升级人工')
      if (
        Object.keys(call.input).some(
          (key) =>
            !(
              name === 'submit_return'
                ? ['orderNo', 'reason', 'itemIds', 'explanation']
                : ['orderNo', 'reason', 'explanation']
            ).includes(key),
        )
      )
        throw new Error('模型不得指定金额或业务授权关联')
      const input = INTENT_SLOT_SCHEMAS[name].parse(call.input)
      const order = new SqliteOrderRepository(this.db).findByOrderNoSync(input.orderNo)
      if (!order) throw new Error('订单不存在')
      const returns = new SqliteReturnRepository(this.db)
      const prepared = services.afterSale.prepareReturnRequest(
        { role: 'customer', customerId: task.customerId },
        { ...input, type: name === 'submit_return' ? 'return' : 'refund_only' },
        order,
        new SqliteShipmentRepository(this.db).findByOrderNoSync(input.orderNo),
        returns.listByOrderNoSync(input.orderNo),
      )
      const { record, refund, result } = prepared
      returns.createSync(record)
      if (refund) {
        new SqliteRefundRepository(this.db).createSync(refund)
        new ExecutionOwnershipRepository(this.db).registerNew(refund.idempotencyKey)
      }
      const approval = result.requiresApproval
        ? services.approvals.prepare({
            runId: task.runId,
            resourceType: 'return_request',
            resourceId: record.returnNo,
            amountCents: result.refundAmountCents,
            reason: result.policyExplanation,
            requestedBy: 'workflow',
          })
        : undefined
      if (approval) new SqliteApprovalRepository(this.db).createSync(approval)
      const binding = {
        customerId: task.customerId,
        orderNo: record.orderNo,
        type: record.type,
        reason: record.reason,
        itemIds: record.itemIds,
        policy: record.policyDecision,
        policyVersion: record.policyVersion,
        refundNo: result.refundNo,
        amountCents: record.refundAmountCents,
        currency: record.currency,
      }
      this.db
        .prepare(
          `INSERT INTO p6_conversation_refunds
        (run_id,origin_task_id,step_key,tool_call_id,tool_name,return_no,approval_id,binding_json)
        VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          task.runId,
          task.taskId,
          step,
          call.toolCallId,
          name,
          record.returnNo,
          approval?.approvalId ?? null,
          JSON.stringify(binding),
        )
      this.db
        .prepare('INSERT INTO checkpoints(run_id,step_id,state_json,created_at) VALUES (?,?,?,?)')
        .run(
          task.runId,
          'conversation_refund',
          JSON.stringify({
            ...result,
            approvalId: approval?.approvalId,
            approvalResourceType: 'return_request',
            approvalToken: approval?.oneTimeToken,
            originTaskId: task.taskId,
            toolCallId: call.toolCallId,
          }),
          new Date().toISOString(),
        )
      if (result.policyOutcome === 'allow') {
        if (!refund) throw new Error('自动授权缺少原退款')
        const authorization = new ExecutionOwnershipRepository(this.db).takeoverWithCommand(
          refund.idempotencyKey,
          () =>
            this.tasks.accept({
              requestKey: `automatic:${record.returnNo}`,
              kind: 'message',
              runId: task.runId,
              customerId: task.customerId,
              config: task.input.config,
              requestPayload: { ...binding, returnNo: record.returnNo, action: 'automatic_refund' },
              plan: {
                input: '执行领域自动批准方案',
                tool: record.type === 'return' ? 'after_sale_wait' : 'return_request',
                ...(record.type === 'refund_only'
                  ? { payment: p6ReadyPayment(this.db, 'refund', refund.refundNo, task.customerId) }
                  : {}),
              },
            }),
        )
        this.accepted(authorization)
        this.db
          .prepare('UPDATE p6_conversation_refunds SET authorization_task_id = ? WHERE run_id = ?')
          .run(authorization.taskId, task.runId)
      }
      this.db
        .prepare(
          `INSERT INTO audit_logs(occurred_at,actor_role,actor_id,action,resource_type,resource_id,detail_json,run_id)
        VALUES (?,'customer',?,'return_created','return_request',?,?,?)`,
        )
        .run(
          new Date().toISOString(),
          task.customerId,
          record.returnNo,
          JSON.stringify({ ...binding, policyOutcome: result.policyOutcome }),
          task.runId,
        )
      this.tasks.checkpoint(task, step, { returnNo: record.returnNo, pendingBusinessResult: true })
      if (approval)
        this.journal.append(task.runId, 'approval.required', {
          approvalId: approval.approvalId,
          resourceType: 'return_request',
          resourceId: record.returnNo,
          amountCents: approval.amountCents,
          reason: approval.reason,
          expiresAt: approval.expiresAt,
          riskLevel: 'high',
        })
      if (approval) {
        this.journal.append(task.runId, 'message.completed', {
          role: 'assistant',
          text: `售后单 ${record.returnNo} 等待主管审批 尚未退款`,
        })
        this.journal.append(task.runId, 'run.paused', { reason: 'awaiting_approval' })
      }
      this.db
        .prepare('UPDATE agent_runs SET status = ?, updated_at = ? WHERE run_id = ?')
        .run(approval ? 'awaiting_approval' : 'running', new Date().toISOString(), task.runId)
      this.tasks.finish(task, 'completed')
    })
  }

  private accepted(task: P6Task): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO p6_events(task_id,event_key,payload_json) VALUES (?,'business-accepted','{}')",
      )
      .run(task.taskId)
  }

  /** 每次推进与发送都校验原冻结方案 不接受被替换的售后单或工具调用 */
  validate(link: Link) {
    const origin = this.tasks.get(link.origin_task_id)
    const record = new SqliteReturnRepository(this.db).findByReturnNoSync(link.return_no)
    const refund = new SqliteRefundRepository(this.db).findByReturnNoSync(link.return_no)
    const binding = JSON.parse(link.binding_json) as Record<string, unknown>
    if (
      !origin ||
      !record ||
      origin.runId !== link.run_id ||
      origin.customerId !== record.customerId ||
      binding.customerId !== record.customerId ||
      binding.orderNo !== record.orderNo ||
      binding.type !== record.type ||
      binding.reason !== record.reason ||
      JSON.stringify(binding.itemIds) !== JSON.stringify(record.itemIds) ||
      JSON.stringify(binding.policy) !== JSON.stringify(record.policyDecision) ||
      binding.policyVersion !== record.policyVersion ||
      binding.amountCents !== record.refundAmountCents ||
      binding.currency !== record.currency ||
      binding.refundNo !== (refund?.refundNo ?? null) ||
      (refund &&
        (refund.amountCents !== record.refundAmountCents ||
          refund.currency !== record.currency ||
          refund.orderNo !== record.orderNo ||
          refund.idempotencyKey !== refundIdempotencyKey(record.returnNo)))
    )
      throw new Error('原会话退款业务关联冲突')
    const turnNumber = /^tool:(\d+):/.exec(link.step_key)?.[1]
    const turn = turnNumber
      ? (this.tasks.step(origin.taskId, `turn:${turnNumber}`) as
          | {
              blocks: Array<{
                type: string
                toolCallId?: string
                toolName?: string
                input?: Record<string, unknown>
              }>
            }
          | undefined)
      : undefined
    const matched = turn?.blocks.find(
      (block) =>
        block.type === 'tool_use' &&
        block.toolCallId === link.tool_call_id &&
        block.toolName === link.tool_name,
    )
    const checkpoint = this.tasks.step(origin.taskId, link.step_key) as
      { returnNo?: string } | undefined
    if (
      !matched ||
      checkpoint?.returnNo !== record.returnNo ||
      matched.input?.orderNo !== record.orderNo ||
      matched.input?.reason !== record.reason
    )
      throw new Error('原动作检查点不匹配')
    if (!link.approval_id && link.authorization_task_id) {
      const authorization = this.tasks.get(link.authorization_task_id)
      const payload = authorization?.input.requestPayload
      if (
        !authorization ||
        authorization.runId !== link.run_id ||
        authorization.customerId !== origin.customerId ||
        payload?.returnNo !== record.returnNo ||
        payload.action !== 'automatic_refund' ||
        Object.entries(binding).some(
          ([key, value]) => JSON.stringify(payload[key]) !== JSON.stringify(value),
        )
      )
        throw new Error('原自动授权内容不匹配')
    }
    return { origin, record, refund, binding }
  }

  /** 收货延续原审批或自动授权 只有未发送许可可以转绑 */
  receive(returnNo: string): P6Task {
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare('SELECT * FROM p6_conversation_refunds WHERE return_no = ?')
          .get(returnNo) as Link | undefined
        if (!row) throw new Error('原会话退款流程不存在')
        const { origin, record, refund } = this.validate(row)
        if (row.approval_id)
          return new P6OwnedAfterSale(this.db).receive({
            approvalId: row.approval_id,
            returnNo,
            runId: row.run_id,
            customerId: origin.customerId,
          })
        const authorization = row.authorization_task_id
          ? this.tasks.get(row.authorization_task_id)
          : undefined
        if (
          !authorization ||
          authorization.input.plan.tool !== 'after_sale_wait' ||
          record.type !== 'return' ||
          record.policyDecision.outcome !== 'allow' ||
          !refund ||
          authorization.runId !== row.run_id ||
          authorization.input.requestPayload?.returnNo !== returnNo ||
          !['queued', 'running', 'completed'].includes(authorization.status)
        )
          throw new Error('收货缺少原自动授权')
        const key = receiveGoodsIdempotencyKey(returnNo)
        const existing = this.tasks.findRequest(origin.customerId, key)
        if (existing) {
          if (
            existing.runId !== row.run_id ||
            existing.input.requestPayload?.authorizationTaskId !== authorization.taskId ||
            existing.input.requestPayload?.returnNo !== returnNo
          )
            throw new Error('原收货命令不匹配')
          return existing
        }
        const ownership = new ExecutionOwnershipRepository(this.db).get(refund.idempotencyKey)
        if (
          record.status !== 'buyer_shipped' ||
          refund.status !== 'created' ||
          ownership?.owner !== 'p6' ||
          ownership.state !== 'ready' ||
          ownership.token ||
          ownership.holder !== authorization.commandId
        )
          throw new Error('收货前置或原发送许可冲突')
        assertReturnTransition(record.status, 'goods_received')
        this.db
          .prepare(
            "UPDATE return_requests SET status = 'goods_received', version = version + 1, updated_at = ? WHERE return_no = ?",
          )
          .run(new Date().toISOString(), returnNo)
        const task = this.tasks.accept({
          requestKey: key,
          kind: 'message',
          runId: row.run_id,
          customerId: origin.customerId,
          config: authorization.input.config,
          requestPayload: {
            returnNo,
            authorizationTaskId: authorization.taskId,
            action: 'receive_goods',
          },
          plan: {
            input: '执行原自动授权的收货退款',
            tool: 'return_request',
            payment: p6ReadyPayment(this.db, 'refund', refund.refundNo, origin.customerId),
          },
        })
        const changed = this.db
          .prepare(
            "UPDATE execution_ownership SET holder = ? WHERE business_key = ? AND owner = 'p6' AND holder = ? AND state = 'ready' AND token IS NULL",
          )
          .run(task.commandId, refund.idempotencyKey, authorization.commandId).changes
        if (changed !== 1) throw new Error('收货转绑冲突')
        this.accepted(task)
        this.db
          .prepare(
            `INSERT INTO audit_logs(occurred_at,actor_role,actor_id,action,resource_type,resource_id,detail_json,run_id) VALUES (?,'system','p6-after-sale','return_goods_received','return_request',?,'{}',?)`,
          )
          .run(new Date().toISOString(), returnNo, row.run_id)
        return task
      })
      .immediate()
  }

  /** 客户结构化寄回只绑定该会话原授权 不让模型决定收货或付款 */
  shipment(runId: string, customerId: string, returnNo: string, trackingNo: string): void {
    const link = this.link(runId)
    if (!link || link.return_no !== returnNo || !trackingNo.trim() || trackingNo.length > 100)
      throw new Error('寄回关联不匹配')
    const { record } = this.validate(link)
    if (record.customerId !== customerId || record.type !== 'return')
      throw new Error('无权登记寄回')
    if (record.status === 'buyer_shipped') return
    if (record.status !== 'awaiting_buyer_shipment') throw new Error('尚未取得寄回授权')
    assertReturnTransition(record.status, 'buyer_shipped')
    this.db
      .prepare(
        "UPDATE return_requests SET status = 'buyer_shipped', version = version + 1, updated_at = ? WHERE return_no = ?",
      )
      .run(new Date().toISOString(), returnNo)
    this.journal.append(runId, 'message.completed', {
      role: 'assistant',
      text: '已登记寄回 等待仓库确认收货 尚未退款',
    })
    this.db
      .prepare(
        `INSERT INTO audit_logs(occurred_at,actor_role,actor_id,action,resource_type,resource_id,detail_json,run_id) VALUES (?,'customer',?,'return_shipment_recorded','return_request',?,?,?)`,
      )
      .run(new Date().toISOString(), customerId, returnNo, JSON.stringify({ trackingNo }), runId)
  }

  /** 精确原调用仅投影一次 等待和未知只发布进度 */
  project(): void {
    this.db
      .transaction(() => {
        const links = this.db
          .prepare('SELECT * FROM p6_conversation_refunds WHERE projected = 0')
          .all() as Link[]
        for (const link of links) {
          const { record, refund } = this.validate(link)
          const tasks = (
            this.db
              .prepare(
                "SELECT task_id AS id FROM p6_tasks WHERE run_id = ? AND tool != 'conversation'",
              )
              .all(link.run_id) as { id: string }[]
          ).map((row) => this.tasks.get(row.id)!)
          const failed = tasks.some((task) =>
            ['call_failed', 'business_failed', 'cancelled', 'needs_confirmation'].includes(
              task.status,
            ),
          )
          const effect = refund
            ? (this.db
                .prepare(
                  'SELECT status,result_json AS result FROM p6_effects WHERE business_key = ?',
                )
                .get(refund.idempotencyKey) as
                { status: string; result: string | null } | undefined)
            : undefined
          const ownership = refund
            ? new ExecutionOwnershipRepository(this.db).get(refund.idempotencyKey)
            : undefined
          const succeeded = record.status === 'completed' && refund?.status === 'succeeded'
          if (
            succeeded &&
            (effect?.status !== 'succeeded' ||
              ownership?.owner !== 'p6' ||
              ownership.state !== 'succeeded' ||
              !ownership.token)
          )
            throw new Error('退款成功缺少原渠道及发送许可确认')
          const rejected = ['rejected', 'expired', 'cancelled'].includes(record.status)
          const uncertain = Boolean(effect && !['succeeded', 'rejected'].includes(effect.status))
          const terminal =
            succeeded ||
            (rejected && !uncertain) ||
            (failed && !uncertain && !tasks.some((task) => task.status === 'needs_confirmation'))
          const waiting = ['awaiting_buyer_shipment', 'buyer_shipped'].includes(record.status)
          const text = succeeded
            ? '模拟渠道已确认退款成功'
            : uncertain
              ? '资金结果待核验 请联系人工处理 不会自动重新退款'
              : rejected
                ? '售后申请已拒绝或过期 未执行退款'
                : effect?.status === 'rejected'
                  ? '模拟渠道明确拒绝退款 请联系人工处理'
                  : failed
                    ? '退款流程已停止 未确认退款成功 请联系人工处理'
                    : waiting
                      ? `售后单 ${record.returnNo} 已批准 等待寄回或收货 尚未退款`
                      : ''
          if (!text) continue
          const progressKey = terminal
            ? 'refund-result'
            : `refund-progress:${record.status}:${failed}`
          if (
            this.db
              .prepare('SELECT 1 FROM p6_events WHERE task_id = ? AND event_key = ?')
              .get(link.origin_task_id, progressKey)
          )
            continue
          if (terminal) {
            const result = {
              toolCallId: link.tool_call_id,
              toolName: link.tool_name,
              content: JSON.stringify({
                returnNo: record.returnNo,
                refundNo: refund?.refundNo ?? null,
                returnStatus: record.status,
                refundStatus: refund?.status ?? null,
                amountCents: record.refundAmountCents,
                summary: text,
              }),
              isError: !succeeded,
            }
            this.journal.append(link.run_id, 'agent.tool_results', { results: [result] })
            this.journal.append(link.run_id, 'tool.completed', {
              toolName: link.tool_name,
              status: succeeded ? 'succeeded' : 'failed',
              result: JSON.parse(result.content),
            })
            this.db
              .prepare('UPDATE p6_steps SET value_json = ? WHERE task_id = ? AND step = ?')
              .run(
                JSON.stringify({ returnNo: record.returnNo, pendingBusinessResult: false, result }),
                link.origin_task_id,
                link.step_key,
              )
            this.db
              .prepare('UPDATE p6_conversation_refunds SET projected = 1 WHERE run_id = ?')
              .run(link.run_id)
          }
          this.journal.append(link.run_id, 'message.completed', { role: 'assistant', text })
          const status = succeeded
            ? 'completed'
            : rejected || failed
              ? 'escalated'
              : 'awaiting_input'
          this.db
            .prepare(
              "UPDATE agent_runs SET status = ?, updated_at = ? WHERE run_id = ? AND status NOT IN ('handling_human','completed','escalated')",
            )
            .run(status, new Date().toISOString(), link.run_id)
          const run = this.db
            .prepare('SELECT status FROM agent_runs WHERE run_id = ?')
            .get(link.run_id) as { status: string }
        if (run.status === status)
            this.journal.append(
              link.run_id,
              terminal
                ? succeeded
                  ? 'run.completed'
                  : 'run.escalated'
                : failed
                  ? 'run.escalated'
                  : 'run.paused',
              {
                reason: waiting && !failed ? 'awaiting_input' : text,
                summary: text,
                returnNo: record.returnNo,
                escalated: !succeeded && terminal,
              },
            )
          this.db
            .prepare('INSERT INTO p6_events(task_id,event_key,payload_json) VALUES (?,?,?)')
            .run(link.origin_task_id, progressKey, JSON.stringify({ returnNo: record.returnNo }))
        }
      })
      .immediate()
  }
}

/** 自动批准也验证原会话授权 收货不能借用别人的资金任务 */
export function assertConversationRefundPayment(
  db: SqliteDatabase,
  payment: P6Payment,
  task: P6Task,
): void {
  const repository = new P6ConversationRefundRepository(db)
  const link = repository.link(task.runId)
  if (!link) return
  const { record, refund } = repository.validate(link)
  if (
    !refund ||
    payment.resourceId !== `refund:${refund.refundNo}` ||
    payment.businessKey !== refund.idempotencyKey ||
    payment.amountCents !== refund.amountCents ||
    payment.currency !== refund.currency
  )
    throw new Error('会话资金计划冲突')
  if (link.approval_id) return
  const tasks = new P6TaskRepository(db)
  const authorization = link.authorization_task_id
    ? tasks.get(link.authorization_task_id)
    : undefined
  if (
    !authorization ||
    authorization.runId !== task.runId ||
    authorization.customerId !== task.customerId ||
    authorization.input.requestPayload?.returnNo !== record.returnNo ||
    record.policyDecision.outcome !== 'allow'
  )
    throw new Error('原自动授权不匹配')
  if (
    record.type === 'refund_only'
      ? task.taskId !== authorization.taskId
      : task.input.requestPayload?.authorizationTaskId !== authorization.taskId ||
        task.input.requestPayload?.returnNo !== record.returnNo ||
        task.input.requestPayload?.action !== 'receive_goods' ||
        record.status !== 'goods_received'
  )
    throw new Error('自动授权任务不匹配')
}
