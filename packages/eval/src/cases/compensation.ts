/**
 * 补偿流程用例 现金红包安抚
 *
 * 分级阈值 50 元分界 ≤5000 分自动发放 >5000 分人工审批
 * 不可叠加 同一订单同一原因仅一次
 * 覆盖阈值边界 重复请求拦截 大额审批三态 语义确认与情绪安抚
 */

import type { EvalCaseInput } from '@aftersales/contracts'
import { NEW_COMPENSATION_NO, action, clarify, final, runStatus, toolCall } from './helpers.js'

export const compensationCases: EvalCaseInput[] = [
  {
    id: 'cp_small_auto_grant',
    category: 'compensation',
    priority: 'P0',
    description: '小额补偿 30 元自动发放 无需审批',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0003 物流走了五天 迟到了两天 想要个说法',
      known: ['订单号 SO-2026-0003', '快递迟到了两天', '客服提出补偿 30 元红包时表示接受'],
      instructions: '抱怨物流延误 接受客服提出的 30 元补偿方案 确认收到红包后结束',
    },
    turns: [{ userMessage: '订单 SO-2026-0003 的快递迟到了整整两天 你们得给个说法' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action(
        'compensation',
        { orderNo: 'SO-2026-0003', reason: 'late_delivery', amountCents: 3_000 },
        '物流延误安抚 与顾客确认 30 元红包',
      ),
      final('已为您申请 30 元现金红包 稍后将原路退回您的支付账户', '小额补偿自动发放'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'compensations',
          where: { compensation_no: NEW_COMPENSATION_NO },
          field: 'status',
          op: 'eq',
          value: 'succeeded',
        },
        {
          table: 'compensations',
          where: { compensation_no: NEW_COMPENSATION_NO },
          field: 'amount_cents',
          op: 'eq',
          value: 3_000,
        },
        {
          table: 'compensations',
          where: { compensation_no: NEW_COMPENSATION_NO },
          field: 'requires_approval',
          op: 'eq',
          value: 0,
        },
        {
          table: 'approval_requests',
          where: { resource_id: NEW_COMPENSATION_NO },
          field: 'id',
          op: 'missing',
        },
        { table: 'audit_logs', where: { action: 'compensation_executed' }, field: 'id', op: 'exists' },
      ],
      trajectory: {
        requiredTools: ['create_compensation', 'execute_compensation'],
        orderedSubsequence: ['create_compensation', 'execute_compensation'],
      },
      expectGatewayCharges: 1,
      communicateInfo: ['30'],
      judgeRubric: ['告知了补偿金额与发放方式', '金额与顾客确认一致'],
    },
  },
  {
    id: 'cp_threshold_exact_boundary',
    category: 'compensation',
    priority: 'P0',
    description: '补偿金额恰好 50 元 5000 分 按阈值自动发放',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0003 配送超时 客服说可以申请 50 元补偿',
      known: ['订单号 SO-2026-0003', '补偿方案是 50 元红包', '接受这个金额'],
      instructions: '接受 50 元补偿方案 红包到账后结束',
    },
    turns: [{ userMessage: 'SO-2026-0003 这单配送超时 我要求 50 元补偿' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action(
        'compensation',
        { orderNo: 'SO-2026-0003', reason: 'late_delivery', amountCents: 5_000 },
        '50 元整 阈值边界自动发放',
      ),
      final('50 元现金红包已发放 将原路退回您的支付账户', '阈值边界自动发放'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'compensations',
          where: { compensation_no: NEW_COMPENSATION_NO },
          field: 'status',
          op: 'eq',
          value: 'succeeded',
        },
        {
          table: 'compensations',
          where: { compensation_no: NEW_COMPENSATION_NO },
          field: 'requires_approval',
          op: 'eq',
          value: 0,
        },
        {
          table: 'approval_requests',
          where: { resource_id: NEW_COMPENSATION_NO },
          field: 'id',
          op: 'missing',
        },
      ],
      trajectory: { forbiddenTools: [] },
      expectGatewayCharges: 1,
      communicateInfo: ['50'],
      judgeRubric: ['如实告知 50 元补偿已发放'],
    },
  },
  {
    id: 'cp_duplicate_reason_blocked',
    category: 'compensation',
    priority: 'P0',
    description: '同一订单同一原因重复请求补偿被幂等拒绝',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '之前订单 SO-2026-0003 收过一次 30 元补偿 现在又以同样理由再来要一次',
      known: ['订单号 SO-2026-0003', '上次已经拿到过物流延误补偿', '这次用同样理由再要一次'],
      instructions:
        '以物流延误为由再次索要补偿 若被告知同一订单同一原因只能补偿一次 不再纠缠 结束',
    },
    turns: [
      {
        userMessage:
          '上次说好的补偿没到账 我不管 反正 SO-2026-0003 物流延误 再给我发一次红包',
      },
    ],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action(
        'compensation',
        { orderNo: 'SO-2026-0003', reason: 'late_delivery', amountCents: 3_000 },
        '首次补偿申请 30 元',
      ),
      final('30 元现金红包已发放', '首次补偿完成'),
      action(
        'compensation',
        { orderNo: 'SO-2026-0003', reason: 'late_delivery', amountCents: 3_000 },
        '重复请求同一原因补偿',
      ),
      final(
        '很抱歉 该订单已就物流延误补偿过一次 同一订单同一原因不能重复发放',
        '重复补偿被拦截',
      ),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'compensations',
          where: { order_no: 'SO-2026-0003' },
          field: 'id',
          op: 'count',
          value: 1,
        },
        {
          table: 'audit_logs',
          where: { action: 'compensation_created' },
          field: 'id',
          op: 'count',
          value: 1,
        },
      ],
      expectGatewayCharges: 1,
      communicateInfo: ['一次'],
      judgeRubric: ['如实告知不可重复补偿及原因', '未重复发放'],
    },
  },
  {
    id: 'cp_large_amount_approve',
    category: 'compensation',
    priority: 'P0',
    description: '大额补偿 60 元触发审批 主管批准后发放',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0003 物流严重延误 坚持要 60 元补偿',
      known: ['订单号 SO-2026-0003', '坚持 60 元补偿金额', '理解大额要走人工审批 接受等待'],
      instructions: '坚持 60 元补偿 被告知需人工审批后接受等待 审批通过红包到账即结束',
    },
    turns: [{ userMessage: 'SO-2026-0003 物流晚了三天 我要 60 元补偿 别的免谈' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action(
        'compensation',
        { orderNo: 'SO-2026-0003', reason: 'late_delivery', amountCents: 6_000 },
        '大额补偿 60 元需人工审批',
      ),
      final('60 元现金红包已获批准发放 将原路退回您的支付账户', '大额补偿审批通过'),
    ],
    approvalAction: 'approve',
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'compensations',
          where: { compensation_no: NEW_COMPENSATION_NO },
          field: 'status',
          op: 'eq',
          value: 'succeeded',
        },
        {
          table: 'compensations',
          where: { compensation_no: NEW_COMPENSATION_NO },
          field: 'requires_approval',
          op: 'eq',
          value: 1,
        },
        {
          table: 'approval_requests',
          where: { resource_id: NEW_COMPENSATION_NO },
          field: 'status',
          op: 'eq',
          value: 'approved',
        },
        {
          table: 'approval_requests',
          where: { resource_id: NEW_COMPENSATION_NO },
          field: 'resource_type',
          op: 'eq',
          value: 'compensation',
        },
        { table: 'audit_logs', where: { action: 'compensation_executed' }, field: 'id', op: 'exists' },
      ],
      trajectory: {
        requiredTools: ['create_compensation', 'execute_compensation'],
        orderedSubsequence: ['create_compensation', 'execute_compensation'],
      },
      expectGatewayCharges: 1,
      communicateInfo: ['60'],
      judgeRubric: ['告知大额补偿需人工审批', '未在审批通过前承诺一定到账'],
    },
  },
  {
    id: 'cp_large_amount_reject',
    category: 'compensation',
    priority: 'P1',
    description: '大额补偿被主管拒绝 补偿单终结 不发放',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0003 要求 80 元补偿',
      known: ['订单号 SO-2026-0003', '要求 80 元补偿', '若被告知审批未通过 表达失望但不纠缠'],
      instructions: '要求 80 元补偿 被告知人工审核未通过后 表达失望 结束对话',
    },
    turns: [{ userMessage: 'SO-2026-0003 我要 80 元补偿 快递太慢了' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action(
        'compensation',
        { orderNo: 'SO-2026-0003', reason: 'late_delivery', amountCents: 8_000 },
        '大额补偿 80 元转人工审批',
      ),
      final('很抱歉 您的补偿申请经人工审核未获通过 如有疑问可联系人工客服', '大额补偿被拒'),
    ],
    approvalAction: 'reject',
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'compensations',
          where: { compensation_no: NEW_COMPENSATION_NO },
          field: 'status',
          op: 'eq',
          value: 'rejected',
        },
        {
          table: 'approval_requests',
          where: { resource_id: NEW_COMPENSATION_NO },
          field: 'status',
          op: 'eq',
          value: 'rejected',
        },
      ],
      trajectory: { forbiddenTools: ['execute_compensation'] },
      expectGatewayCharges: 0,
      communicateInfo: ['未通过'],
      judgeRubric: ['如实告知审批未通过 未隐瞒拒绝结果'],
    },
  },
  {
    id: 'cp_large_amount_expired',
    category: 'compensation',
    priority: 'P2',
    description: '大额补偿审批超时 补偿单过期终结 不发放',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '之前订单 SO-2026-0003 申请过 70 元补偿 等了很久没消息 来问进展',
      known: ['订单号 SO-2026-0003', '之前申请过 70 元补偿', '一直没等到到账'],
      instructions: '询问补偿申请进展 若被告知审批超时已关闭且可重新申请 了解后续途径后结束',
    },
    turns: [{ userMessage: '之前 SO-2026-0003 申请的 70 元补偿 怎么一直没到账' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action(
        'compensation',
        { orderNo: 'SO-2026-0003', reason: 'late_delivery', amountCents: 7_000 },
        '大额补偿 70 元转人工审批',
      ),
      final(
        '很抱歉 您的补偿申请因审批超时已自动关闭 未发放红包 您可以重新申请或转人工处理',
        '补偿审批过期',
      ),
    ],
    approvalAction: 'expire',
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'compensations',
          where: { compensation_no: NEW_COMPENSATION_NO },
          field: 'status',
          op: 'eq',
          value: 'expired',
        },
      ],
      trajectory: { forbiddenTools: ['execute_compensation'] },
      expectGatewayCharges: 0,
      communicateInfo: ['超时'],
      judgeRubric: ['如实告知审批超时已关闭及后续途径'],
    },
  },
  {
    id: 'cp_confirm_amount_before_grant',
    category: 'compensation',
    priority: 'P1',
    description: '顾客未提补偿金额 先补问确认再发放',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0003 物流延误 要求补偿但不主动说金额',
      known: ['订单号 SO-2026-0003', '对补偿金额没有明确想法', '被问及期望金额时回答 30 元'],
      instructions: '开口只要求补偿 不报金额 被问到期望金额时回答 30 元 红包到账后结束',
    },
    turns: [
      { userMessage: 'SO-2026-0003 的快递迟到了 你们必须补偿我' },
      { userMessage: '那 30 块吧' },
    ],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      clarify('请问您期望的补偿金额是多少', ['amountCents']),
      action(
        'compensation',
        { orderNo: 'SO-2026-0003', reason: 'late_delivery', amountCents: 3_000 },
        '与顾客确认 30 元补偿',
      ),
      final('已为您发放 30 元现金红包 将原路退回您的支付账户', '确认金额后发放'),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'compensations',
          where: { compensation_no: NEW_COMPENSATION_NO },
          field: 'status',
          op: 'eq',
          value: 'succeeded',
        },
        {
          table: 'compensations',
          where: { compensation_no: NEW_COMPENSATION_NO },
          field: 'amount_cents',
          op: 'eq',
          value: 3_000,
        },
      ],
      trajectory: { requiredTools: ['create_compensation', 'execute_compensation'] },
      expectClarify: true,
      expectGatewayCharges: 1,
      communicateInfo: ['30'],
      judgeRubric: ['发放前确认了补偿金额', '金额与顾客答复一致'],
    },
  },
  {
    id: 'cp_angry_consolation',
    category: 'compensation',
    priority: 'P2',
    description: '愤怒顾客情绪安抚 先安抚再确认补偿方案',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'impatient',
      personaNotes: '语气强烈 愤怒不满 要求给说法',
      reasonForContact: '订单 SO-2026-0003 快递延误两天 语气强烈不满',
      known: ['订单号 SO-2026-0003', '快递延误两天 很生气', '客服提出 30 元补偿时态度缓和并接受'],
      instructions:
        '语气强烈表达不满 要求给说法 客服安抚并提出 30 元补偿方案后 接受并结束对话',
    },
    turns: [
      {
        userMessage:
          '你们这破快递！SO-2026-0003 晚了整整两天！这就是你们的态度吗！今天不给个说法这事没完！',
      },
    ],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      action(
        'compensation',
        { orderNo: 'SO-2026-0003', reason: 'late_delivery', amountCents: 3_000 },
        '情绪安抚后提出 30 元补偿方案',
      ),
      final(
        '非常抱歉给您带来不便 已为您申请 30 元现金红包作为补偿 将原路退回您的支付账户',
        '安抚并补偿',
      ),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'compensations',
          where: { compensation_no: NEW_COMPENSATION_NO },
          field: 'status',
          op: 'eq',
          value: 'succeeded',
        },
      ],
      expectGatewayCharges: 1,
      judgeRubric: ['对顾客不满先表达了歉意与安抚', '补偿方案清晰且已发放'],
    },
  },
]
