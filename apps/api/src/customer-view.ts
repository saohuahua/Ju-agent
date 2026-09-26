import type { AgentEventRow } from '@aftersales/contracts'
import type { AgentRunRecord } from '@aftersales/domain'
import { redactText } from '@aftersales/domain'

/**
 * 客户事件采用字段白名单 新事件默认不公开
 * 保留原序号供断线续传 被隐藏的事件不能改变后续事件身份
 * 运行诊断统一换成客户提示 不把内部错误详情带到浏览器
 */
export function customerEvent(event: AgentEventRow): AgentEventRow | null {
  const input =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : {}
  let payload: Record<string, unknown>
  const text = (key: string) => (typeof input[key] === 'string' ? redactText(input[key]) : '')

  switch (event.type) {
    case 'message.user':
    case 'message.completed':
    case 'operator.message':
      payload = { text: text('text') }
      break
    case 'message.delta':
      payload = { textDelta: text('textDelta') }
      break
    case 'run.paused':
      payload = {
        reason: input.reason === 'awaiting_input' ? 'awaiting_input' : 'awaiting_approval',
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
    case 'run.escalated':
    case 'run.handover':
      payload = {}
      break
    default:
      return null
  }

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
