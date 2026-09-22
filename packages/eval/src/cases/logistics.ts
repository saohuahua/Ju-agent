/**
 * 物流推送用例 会话中途注入物流事件
 *
 * 混合到达语义 会话空闲时事件即达即触达 驱动主动告知回合
 * 其余状态事件落表挂起 下一轮对话自然带出 已完结会话不触达
 * 注入经领域校验 未知订单 已签收订单 重复注入均拒绝
 */

import type { EvalCaseInput } from '@aftersales/contracts'
import { NEW_RETURN_NO, action, clarify, final, runStatus, toolCall } from './helpers.js'

export const logisticsCases: EvalCaseInput[] = [
  {
    id: 'lg_delayed_idle_push',
    category: 'happy_path',
    priority: 'P0',
    description: '会话空闲时注入运输延误 即达即触达 主动告知客户',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0002 的蓝牙音箱一直没到 询问物流进展',
      known: ['订单号 SO-2026-0002', '快递已经走了好几天'],
      instructions:
        '询问物流进展 开场不提供订单号 被客服询问后提供 SO-2026-0002 客服主动告知延误原因与预计时效后 接受并结束',
    },
    turns: [
      { userMessage: '我的快递怎么还没到 帮我查一下' },
      { userMessage: '订单号是 SO-2026-0002' },
    ],
    modelScript: [
      toolCall('get_shipment', { orderNo: 'SO-2026-0002' }),
      clarify('正在为您查询物流信息 请稍候', ['orderNo']),
      toolCall('get_shipment', { orderNo: 'SO-2026-0002' }),
      final(
        '非常抱歉 您的包裹因分拨中心积压出现运输延误 预计延迟两天送达 我们会持续为您跟进',
        '物流延误主动触达',
      ),
    ],
    logisticsEvents: [
      {
        at: 'after_turn',
        turnIndex: 1,
        orderNo: 'SO-2026-0002',
        status: 'delayed',
        description: '上海浦东分拨中心积压 预计延迟两天',
        eventId: 'lg-delayed-1',
      },
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'shipments',
          where: { order_no: 'SO-2026-0002' },
          field: 'status',
          op: 'eq',
          value: 'delayed',
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'logistics.event' },
          field: 'id',
          op: 'exists',
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'message.completed' },
          field: 'payload_json',
          op: 'contains',
          value: '延误',
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'run.resumed' },
          field: 'payload_json',
          op: 'contains',
          value: 'logistics_event',
        },
        {
          table: 'audit_logs',
          where: { action: 'logistics_event_injected' },
          field: 'id',
          op: 'exists',
        },
      ],
    },
  },
  {
    id: 'lg_lost_idle_push',
    category: 'happy_path',
    priority: 'P0',
    description: '会话空闲时注入丢件 即达即触达 主动告知并安抚',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'impatient',
      personaNotes: '等待多日 语气不耐烦',
      reasonForContact: '订单 SO-2026-0002 的包裹好几天没更新 来质问',
      known: ['订单号 SO-2026-0002', '物流信息停了好几天'],
      instructions:
        '质问物流 开场不提供订单号 被客服询问后提供 SO-2026-0002 若客服告知丢件并给出补救方案 接受并结束',
    },
    turns: [
      { userMessage: '我的快递到底怎么回事 物流好几天不更新了' },
      { userMessage: '订单号是 SO-2026-0002' },
    ],
    modelScript: [
      toolCall('get_shipment', { orderNo: 'SO-2026-0002' }),
      clarify('正在为您核实物流信息 请稍候', ['orderNo']),
      toolCall('get_shipment', { orderNo: 'SO-2026-0002' }),
      final(
        '非常抱歉 经核实您的包裹在运输途中丢失 我们会立即为您处理 您可以申请全额退款 我们也会催促物流方排查',
        '丢件主动触达',
      ),
    ],
    logisticsEvents: [
      {
        at: 'after_turn',
        turnIndex: 1,
        orderNo: 'SO-2026-0002',
        status: 'lost',
        description: '物流方确认包裹丢失',
        eventId: 'lg-lost-1',
      },
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'shipments',
          where: { order_no: 'SO-2026-0002' },
          field: 'status',
          op: 'eq',
          value: 'lost',
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'message.completed' },
          field: 'payload_json',
          op: 'contains',
          value: '丢失',
        },
      ],
    },
  },
  {
    id: 'lg_lost_refund_closed_loop',
    category: 'happy_path',
    priority: 'P0',
    description: '注入丢件后触达回合主动发起仅退款 政策放行 退款闭环',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0002 物流迟迟未到 询问进展',
      known: ['订单号 SO-2026-0002', '物流三天没有更新'],
      instructions:
        '询问物流进展 开场不提供订单号 被客服询问后提供 SO-2026-0002 若被告知丢件且可全额退款 接受退款并结束',
    },
    turns: [
      { userMessage: '我的快递怎么一直没动静 帮我看看' },
      { userMessage: '订单号是 SO-2026-0002' },
    ],
    modelScript: [
      toolCall('get_shipment', { orderNo: 'SO-2026-0002' }),
      clarify('正在为您查询 请稍候', ['orderNo']),
      toolCall('get_shipment', { orderNo: 'SO-2026-0002' }),
      action(
        'submit_refund_only',
        { orderNo: 'SO-2026-0002', reason: 'lost_package' },
        '物流确认丢件 主动发起全额退款',
      ),
      final('物流已确认丢件 299 元全额退款将原路退回 很抱歉给您带来不便', '丢件退款闭环'),
    ],
    logisticsEvents: [
      {
        at: 'after_turn',
        turnIndex: 1,
        orderNo: 'SO-2026-0002',
        status: 'lost',
        description: '物流方确认包裹丢失',
        eventId: 'lg-lost-2',
      },
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'shipments',
          where: { order_no: 'SO-2026-0002' },
          field: 'status',
          op: 'eq',
          value: 'lost',
        },
        {
          table: 'return_requests',
          where: { return_no: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'completed',
        },
        {
          table: 'refunds',
          where: { return_no: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'succeeded',
        },
        {
          table: 'refunds',
          where: { return_no: NEW_RETURN_NO },
          field: 'amount_cents',
          op: 'eq',
          value: 29_900,
        },
      ],
      trajectory: {
        requiredTools: ['create_return_request', 'execute_refund'],
      },
      expectGatewayCharges: 1,
    },
  },
  {
    id: 'lg_pending_approval_queued',
    category: 'approval',
    priority: 'P1',
    description: '会话等待审批时注入物流事件 挂起不触达 审批恢复后正常完成',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0001 已付款未发货 要求取消并全额退款',
      known: ['订单号 SO-2026-0001', '还没发货', '金额 6999 元'],
      instructions: '要求取消订单全额退款 被告知大额需人工审批后接受等待 审批通过后结束',
    },
    turns: [{ userMessage: 'SO-2026-0001 还没发货 我要取消订单全额退款' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0001' }),
      action(
        'submit_refund_only',
        { orderNo: 'SO-2026-0001', reason: 'unshipped_cancel' },
        '未发货取消 全额退款',
      ),
      final('您的退款已通过人工审批 6999 元将原路退回您的支付账户', '大额退款审批通过'),
    ],
    approvalAction: 'approve',
    logisticsEvents: [
      {
        at: 'after_turn',
        turnIndex: 1,
        orderNo: 'SO-2026-0002',
        status: 'delayed',
        description: '上海浦东分拨中心积压 预计延迟两天',
        eventId: 'lg-queued-1',
      },
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'shipments',
          where: { order_no: 'SO-2026-0002' },
          field: 'status',
          op: 'eq',
          value: 'delayed',
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'logistics.event' },
          field: 'id',
          op: 'exists',
        },
        {
          table: 'refunds',
          where: { return_no: NEW_RETURN_NO },
          field: 'status',
          op: 'eq',
          value: 'succeeded',
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'message.completed' },
          field: 'id',
          op: 'count',
          value: 1,
          note: '等待审批期间注入不触达 仅审批恢复后一条告知',
        },
      ],
      trajectory: {
        forbiddenTools: [],
      },
      expectGatewayCharges: 1,
    },
  },
  {
    id: 'lg_unknown_order_rejected',
    category: 'rejection',
    priority: 'P1',
    description: '注入不存在的订单被拒绝 事件不落表 会话不受影响',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '随便聊聊 测试系统健壮性',
      known: ['没有具体诉求'],
      instructions: '简单咨询 客服正常回答即可结束',
    },
    turns: [{ userMessage: '你们售后电话是多少' }],
    modelScript: [final('售后热线 400-888-8888 工作时间为每日 9 点到 21 点', '简单咨询')],
    logisticsEvents: [
      {
        at: 'after_turn',
        turnIndex: 1,
        orderNo: 'SO-2026-9999',
        status: 'delayed',
        description: '不存在的订单注入',
        eventId: 'lg-unknown-1',
      },
      {
        at: 'after_turn',
        turnIndex: 1,
        orderNo: 'SO-2026-0009',
        status: 'delayed',
        description: '无物流记录的订单注入',
        eventId: 'lg-unknown-2',
      },
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'logistics.event' },
          field: 'id',
          op: 'count',
          value: 0,
          note: '注入被领域校验拒绝 事件不落表',
        },
        {
          table: 'shipments',
          where: { order_no: 'SO-2026-0002' },
          field: 'status',
          op: 'eq',
          value: 'in_transit',
        },
        {
          table: 'audit_logs',
          where: { action: 'logistics_event_injected' },
          field: 'id',
          op: 'missing',
        },
      ],
    },
  },
  {
    id: 'lg_duplicate_injection_rejected',
    category: 'rejection',
    priority: 'P1',
    description: '同一事件 id 重复注入被幂等拒绝 只生效一次',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0002 询问物流',
      known: ['订单号 SO-2026-0002'],
      instructions: '询问物流进展 客服告知后结束',
    },
    turns: [{ userMessage: 'SO-2026-0002 的快递到哪了' }],
    modelScript: [
      toolCall('get_shipment', { orderNo: 'SO-2026-0002' }),
      clarify('正在为您查询物流信息 请稍候', ['orderNo']),
      toolCall('get_shipment', { orderNo: 'SO-2026-0002' }),
      final('非常抱歉 您的包裹因分拨中心积压出现运输延误 预计延迟两天送达', '延误触达'),
    ],
    logisticsEvents: [
      {
        at: 'after_turn',
        turnIndex: 1,
        orderNo: 'SO-2026-0002',
        status: 'delayed',
        description: '上海浦东分拨中心积压 预计延迟两天',
        eventId: 'lg-dup-1',
      },
      {
        at: 'after_turn',
        turnIndex: 1,
        orderNo: 'SO-2026-0002',
        status: 'delayed',
        description: '重复注入同一事件',
        eventId: 'lg-dup-1',
      },
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'shipments',
          where: { order_no: 'SO-2026-0002' },
          field: 'status',
          op: 'eq',
          value: 'delayed',
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'logistics.event' },
          field: 'id',
          op: 'count',
          value: 1,
          note: '重复注入被幂等拒绝 事件只落一条',
        },
        {
          table: 'audit_logs',
          where: { action: 'logistics_event_injected' },
          field: 'id',
          op: 'count',
          value: 1,
        },
      ],
    },
  },
  {
    id: 'lg_completed_run_no_push',
    category: 'rejection',
    priority: 'P1',
    description: '已完结会话注入物流事件 落表不触达 无新消息',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0002 简单咨询后已结束对话',
      known: ['订单号 SO-2026-0002'],
      instructions: '简单咨询订单状态 客服回答后结束',
    },
    turns: [{ userMessage: 'SO-2026-0002 发货了吗' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0002' }),
      final('您的订单已于 9 月 17 日发出 目前在运输途中', '查询完成'),
    ],
    logisticsEvents: [
      {
        at: 'after_all_turns',
        orderNo: 'SO-2026-0002',
        status: 'delayed',
        description: '上海浦东分拨中心积压 预计延迟两天',
        eventId: 'lg-closed-1',
      },
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'shipments',
          where: { order_no: 'SO-2026-0002' },
          field: 'status',
          op: 'eq',
          value: 'delayed',
          note: '运单数据仍更新 事件照常落表',
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'logistics.event' },
          field: 'id',
          op: 'exists',
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'message.completed' },
          field: 'id',
          op: 'count',
          value: 1,
          note: '已完结会话不触达 无新增触达消息',
        },
      ],
    },
  },
  {
    id: 'lg_delivered_rejected',
    category: 'rejection',
    priority: 'P1',
    description: '已签收订单注入物流事件被拒绝 状态不可回退',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '订单 SO-2026-0003 已签收 简单咨询',
      known: ['订单号 SO-2026-0003', '已签收'],
      instructions: '简单咨询 客服回答后结束',
    },
    turns: [{ userMessage: 'SO-2026-0003 的键盘有保修吗' }],
    modelScript: [
      toolCall('get_order', { orderNo: 'SO-2026-0003' }),
      final('电子类商品支持一年质保 凭订单号即可申请', '保修咨询'),
    ],
    logisticsEvents: [
      {
        at: 'after_turn',
        turnIndex: 1,
        orderNo: 'SO-2026-0003',
        status: 'delayed',
        description: '已签收订单注入延误事件',
        eventId: 'lg-delivered-1',
      },
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'shipments',
          where: { order_no: 'SO-2026-0003' },
          field: 'status',
          op: 'eq',
          value: 'delivered',
          note: '已签收状态不可回退',
        },
        {
          table: 'agent_events',
          where: { run_id: '@runId', type: 'logistics.event' },
          field: 'id',
          op: 'missing',
          note: '注入被领域校验拒绝 事件不落表',
        },
      ],
    },
  },
]
