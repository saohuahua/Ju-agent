import type { SqliteDatabase } from '@aftersales/persistence'

/** 独立集成夹具保留真实审批断点与执行意图 不复用用户演示库 */
export function seedBusiness(db: SqliteDatabase, type = 'return', decision = 'approved'): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO agent_runs(run_id,customer_id,status,prompt_version,model,created_at,updated_at)
    VALUES ('business-run','C1001','awaiting_approval','v1','scripted',?,?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO return_requests
    (return_no,order_no,customer_id,type,reason,status,item_ids_json,refund_amount_cents,currency,policy_decision_json,policy_version,created_at,updated_at)
    VALUES ('RT1','SO-2026-0001','C1001',?,'quality','awaiting_approval','[]',600000,'CNY',?,'v1',?,?)`,
  ).run(type, JSON.stringify({ outcome: 'needs_approval' }), now, now)
  if (type !== 'exchange') {
    db.prepare(
      `INSERT INTO refunds(refund_no,return_no,order_no,amount_cents,currency,channel,status,idempotency_key,created_at,updated_at)
      VALUES ('RF1','RT1','SO-2026-0001',600000,'CNY','local','created','refund:RT1',?,?)`,
    ).run(now, now)
    db.exec("INSERT INTO execution_ownership VALUES ('refund:RT1','legacy','','ready',NULL,NULL)")
  }
  db.prepare(
    `INSERT INTO approval_requests(approval_id,run_id,resource_type,resource_id,reason,amount_cents,requested_by,status,one_time_token,expires_at,created_at)
    VALUES ('AP1','business-run','return_request','RT1','test',600000,'workflow',?,'token',?,?)`,
  ).run(decision, new Date(Date.now() + 3600000).toISOString(), now)
  if (decision !== 'pending')
    db.prepare(
      `INSERT INTO approval_execution_intents
    (approval_id,run_id,decision,decided_by,status,created_at,updated_at)
    VALUES ('AP1','business-run',?,'supervisor','pending',?,?)`,
    ).run(decision, now, now)
  db.prepare('INSERT INTO checkpoints(run_id,step_id,state_json,created_at) VALUES (?,?,?,?)').run(
    'business-run',
    'request_approval',
    JSON.stringify({
      approvalId: 'AP1',
      approvalToken: 'token',
      approvalResourceType: 'return_request',
      returnNo: 'RT1',
      refundNo: type === 'exchange' ? null : 'RF1',
      refundAmountCents: 600000,
      policyOutcome: 'needs_approval',
      requiresApproval: true,
    }),
    now,
  )
  db.prepare(
    'INSERT INTO agent_events(run_id,sequence,type,payload_json,created_at) VALUES (?,?,?,?,?)',
  ).run(
    'business-run',
    1,
    'agent.turn',
    JSON.stringify({
      blocks: [
        {
          type: 'tool_use',
          toolCallId: 'action-1',
          toolName:
            type === 'return'
              ? 'submit_return'
              : type === 'exchange'
                ? 'submit_exchange'
                : 'submit_refund_only',
          input: {},
        },
      ],
    }),
    now,
  )
}
