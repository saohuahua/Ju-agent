import {
  compensationIdempotencyKey,
  priceProtectionIdempotencyKey,
  refundIdempotencyKey,
} from '@aftersales/contracts'
import type { P8BusinessReference } from '../../contracts/src/p8-investigation.js'
import type { SqliteDatabase } from './db.js'

interface Resource extends P8BusinessReference {
  returnNo: string | null
  amount: number | null
  currency: string | null
  resourceValid: number
}

interface ExecutionRow {
  effectStatus: string | null
  payment: string | null
  owner: string | null
  ownershipState: string | null
  holder: string | null
  taskId: string | null
  taskStatus: string | null
  taskCustomer: string | null
  runCustomer: string | null
  commandId: string | null
  input: string | null
}

/** 只读同一事务快照 由客户订单资源推导资金键 不信任客户端引用 */
export function readP8BusinessReferences(
  db: SqliteDatabase,
  customerId: string,
  orderNo: string,
): P8BusinessReference[] {
  return db.transaction(() => {
    const resources = db
      .prepare(
        `
      WITH resources AS (
        SELECT 'return' AS kind, return_no AS id, status, 'return_request' AS resourceType,
          return_no AS returnNo, NULL AS amount, NULL AS currency, 1 AS resourceValid
          FROM return_requests WHERE customer_id = @customerId AND order_no = @orderNo
        UNION ALL SELECT 'compensation', compensation_no, status, 'compensation', NULL, amount_cents, currency, 1
          FROM compensations WHERE customer_id = @customerId AND order_no = @orderNo
        UNION ALL SELECT 'price_protection', protection_no, status, 'price_protection', NULL, amount_cents, currency, 1
          FROM price_protections WHERE customer_id = @customerId AND order_no = @orderNo
        UNION ALL SELECT 'refund', f.refund_no, f.status, 'refund', f.return_no, f.amount_cents, f.currency,
          CASE WHEN f.order_no = r.order_no AND f.amount_cents = r.refund_amount_cents AND f.currency = r.currency
            AND f.idempotency_key = 'refund:' || r.return_no THEN 1 ELSE 0 END
          FROM refunds f JOIN return_requests r ON r.return_no = f.return_no
          WHERE r.customer_id = @customerId AND r.order_no = @orderNo
      )
      SELECT kind,id,status,returnNo,amount,currency,resourceValid FROM resources
      UNION ALL SELECT 'approval', a.approval_id, a.status, NULL, NULL, NULL, 1
        FROM approval_requests a JOIN resources r ON r.id = a.resource_id AND r.resourceType = a.resource_type
      ORDER BY kind,id
    `,
      )
      .all({ customerId, orderNo }) as Resource[]
    return resources.map((resource) => {
      const reference: P8BusinessReference = {
        kind: resource.kind,
        id: resource.id,
        status: resource.status,
      }
      if (!['refund', 'compensation', 'price_protection'].includes(resource.kind)) return reference
      const businessKey =
        resource.kind === 'refund'
          ? refundIdempotencyKey(resource.returnNo!)
          : resource.kind === 'compensation'
            ? compensationIdempotencyKey(resource.id)
            : priceProtectionIdempotencyKey(resource.id)
      const row = db
        .prepare(
          `
        SELECT e.status AS effectStatus,e.payment_json AS payment,o.owner,o.state AS ownershipState,o.holder,
          t.task_id AS taskId,t.status AS taskStatus,t.customer_id AS taskCustomer,t.command_id AS commandId,
          g.customer_id AS runCustomer,c.input_json AS input
        FROM (SELECT @businessKey AS business_key) k
        LEFT JOIN p6_effects e ON e.business_key = k.business_key
        LEFT JOIN execution_ownership o ON o.business_key = k.business_key
        LEFT JOIN p6_tasks t ON t.task_id = COALESCE(e.task_id,(SELECT task_id FROM p6_tasks WHERE command_id = o.holder))
        LEFT JOIN p6_commands c ON c.command_id = t.command_id
        LEFT JOIN agent_runs g ON g.run_id = t.run_id
      `,
        )
        .get({ businessKey }) as ExecutionRow
      if (!row.effectStatus && !row.owner && resource.resourceValid) return reference
      let bindingValid = Boolean(resource.resourceValid)
      const matches = (payment: Record<string, unknown> | undefined) =>
        Boolean(
          payment &&
          payment.businessKey === businessKey &&
          payment.resourceId === `${resource.kind}:${resource.id}` &&
          payment.amountCents === resource.amount &&
          payment.currency === resource.currency,
        )
      try {
        const input = row.input ? JSON.parse(row.input) : null
        if (row.effectStatus)
          bindingValid &&=
            matches(JSON.parse(row.payment!)) &&
            matches(input?.plan?.payment) &&
            row.taskCustomer === customerId &&
            row.runCustomer === customerId &&
            input?.customerId === customerId
        if (row.owner === 'p6') {
          bindingValid &&= Boolean(
            row.holder &&
            row.holder === row.commandId &&
            row.taskCustomer === customerId &&
            row.runCustomer === customerId &&
            input?.customerId === customerId,
          )
          if (!row.effectStatus)
            bindingValid &&=
              matches(input?.plan?.payment) ||
              (resource.kind === 'refund' &&
                input?.plan?.tool === 'after_sale_wait' &&
                input?.requestPayload?.returnNo === resource.returnNo)
        }
        if (row.effectStatus && (row.owner !== 'p6' || row.holder !== row.commandId))
          bindingValid = false
      } catch {
        bindingValid = false
      }
      reference.execution = {
        businessKey,
        effectStatus: row.effectStatus,
        owner: row.owner,
        ownershipState: row.ownershipState,
        taskId: row.taskId,
        taskStatus: row.taskStatus,
        bindingValid,
      }
      return reference
    })
  })()
}
