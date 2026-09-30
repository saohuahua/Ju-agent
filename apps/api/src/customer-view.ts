import type { AgentEventRow } from '@aftersales/contracts'
import { OrderCandidates } from '@aftersales/contracts'
import type { AgentRunRecord } from '@aftersales/domain'
import { redactText } from '@aftersales/domain'

/**
 * 客户事件采用字段白名单 新事件默认不公开
 * 保留原序号供断线续传 被隐藏的事件不能改变后续事件身份
 * 运行诊断统一换成客户提示 不把内部错误详情带到浏览器
 */
export function customerEvent(event: AgentEventRow): AgentEventRow | null {
  // 事件载荷先视为不可信结构 每个公开字段都单独挑选
  const input =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : {}
  let payload: Record<string, unknown>
  const text = (key: string) => (typeof input[key] === 'string' ? redactText(input[key]) : '')

  switch (event.type) {
    case 'human.requested':
      payload = { sourceRunId: typeof input.sourceRunId === 'string' ? input.sourceRunId : null }
      break
    case 'order.candidates': {
      // 候选订单必须符合公开契约 解析失败不向客户透传原数据
      const parsed = OrderCandidates.safeParse(input)
      if (!parsed.success) return null
      payload = parsed.data
      break
    }
    case 'message.user':
      payload = {
        text: text('text'),
        ...(typeof input.requestKey === 'string' && input.requestKey.length <= 200
          ? { requestKey: input.requestKey }
          : {}),
      }
      break
    case 'message.completed':
    case 'operator.message':
      payload = { text: text('text') }
      break
    case 'tool.requested':
    case 'tool.completed': {
      // 只公开已支持的查询动作及稳定标识 不传播参数结果或供应商错误
      if (
        !['list_my_orders', 'get_order', 'get_shipment', 'search_policy'].includes(
          String(input.toolName),
        )
      )
        return null
      const executionId = typeof input.executionId === 'string' ? input.executionId : undefined
      payload = {
        toolName: input.toolName,
        ...(executionId ? { executionId } : {}),
        ...(event.type === 'tool.completed'
          ? { status: input.status === 'succeeded' ? 'succeeded' : 'failed' }
          : {}),
      }
      break
    }
    case 'message.delta':
      payload = { textDelta: text('textDelta') }
      break
    case 'run.paused':
      payload = {
        ...(['ready', 'clarify'].includes(String(input.consultation))
          ? { consultation: input.consultation, showChoices: input.showChoices === true }
          : {}),
        reason: input.reason === 'awaiting_input' ? 'awaiting_input' : 'awaiting_approval',
        ...(['orderNo', 'itemIds'].includes(String(input.missingSlot))
          ? { missingSlot: input.missingSlot }
          : {}),
      }
      break
    case 'run.resolved':
      payload = { summary: text('summary') }
      break
    case 'run.failed':
      payload = { message: '处理暂时中断 请联系售后团队核实进度' }
      break
    case 'run.started':
    case 'run.resumed':
    case 'run.completed':
    case 'run.expired':
    case 'run.escalated':
    case 'run.handover':
      payload = {}
      break
    // 新增内部事件不会自动暴露 必须明确加入公开分支
    default:
      return null
  }

  // 保留原序号 隐藏事件也不能改变断线恢复的位置
  return {
    runId: event.runId,
    sequence: event.sequence,
    type: event.type,
    createdAt: event.createdAt,
    payload,
  }
}

/** 会话列表和详情也不公开模型配置 故障注入与内部错误 */
export function customerRun(run: AgentRunRecord) {
  return {
    runId: run.runId,
    customerId: run.customerId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }
}
