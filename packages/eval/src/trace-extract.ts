/**
 * 从事件流生成 L1 用例草稿
 *
 * 只提取确定性轨迹 夹具与沟通断言留给人工核对
 * 禁止在本模块写入评测集
 */

import type { EvalCaseInput, Intent } from '@aftersales/contracts'
import { ACTION_TOOLS, ASK_USER_TOOL, CONCLUDE_TOOL } from '@aftersales/agent'

const ACTION_SET = new Set<string>(ACTION_TOOLS)

export interface TraceExtractRun {
  runId: string
  customerId: string
  status: string
  promptVersion: string
  model: string
  source: string
  createdAt: string
}

export interface TraceExtractEvent {
  sequence: number
  type: string
  payload: unknown
}

export interface CaseDraftMeta {
  sourceRunId: string
  generatedAt: string
  promptVersion: string
  model: string
  sessionSource: string
  needsReview: Array<'fixture' | 'communicateInfo' | 'expectedState' | 'modelScript'>
}

export interface CaseDraft {
  meta: CaseDraftMeta
  case: EvalCaseInput
}

function asRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

/**
 * 把一次已结束的运行转成用例草稿
 *
 * 前置 事件按 sequence 升序
 * 结果 category 固定 regression frozenTime 取会话创建时刻
 */
export function extractCaseDraft(run: TraceExtractRun, events: TraceExtractEvent[]): CaseDraft {
  const turns: EvalCaseInput['turns'] = []
  const modelScript: EvalCaseInput['modelScript'] = []
  const requiredTools: string[] = []
  let lastAssistant = ''

  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const payload = asRecord(event.payload)
    if (event.type === 'message.user' && typeof payload.text === 'string' && payload.text.trim()) {
      turns.push({ userMessage: payload.text })
    }
    if (event.type === 'message.completed' && typeof payload.text === 'string') {
      lastAssistant = payload.text
    }
    if (event.type !== 'agent.turn') continue
    const blocks = Array.isArray(payload.blocks) ? payload.blocks : []
    const texts: string[] = []
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      const item = block as Record<string, unknown>
      if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text)
      if (item.type !== 'tool_use' || typeof item.toolName !== 'string') continue
      const input =
        item.input && typeof item.input === 'object' ? (item.input as Record<string, unknown>) : {}
      const name = item.toolName
      if (name === CONCLUDE_TOOL) {
        const answer =
          texts.join('') ||
          lastAssistant ||
          (typeof input.summary === 'string' ? input.summary : '会话结束')
        const summary = typeof input.summary === 'string' ? input.summary : answer.slice(0, 60)
        modelScript.push({
          kind: 'final',
          answer: answer || summary,
          escalated: run.status === 'escalated',
          summary,
        })
        continue
      }
      if (name === ASK_USER_TOOL) {
        modelScript.push({
          kind: 'clarify',
          question: typeof input.question === 'string' ? input.question : '请补充信息',
          missingSlots: typeof input.missingSlot === 'string' ? [input.missingSlot] : ['unknown'],
        })
        continue
      }
      if (name === 'escalate') {
        modelScript.push({
          kind: 'escalate',
          reason: typeof input.reason === 'string' ? input.reason : '升级人工',
          escalationKind:
            input.kind === 'emotional' ||
            input.kind === 'service_failure' ||
            input.kind === 'injection_attempt'
              ? input.kind
              : 'customer_request',
        })
        requiredTools.push('escalate')
        continue
      }
      if (ACTION_SET.has(name) && name !== 'escalate') {
        const { explanation, ...slots } = input
        modelScript.push({
          kind: 'action',
          intent: name as Intent,
          slots,
          reason: typeof explanation === 'string' ? explanation : '发起业务动作',
        })
        requiredTools.push(name)
        continue
      }
      requiredTools.push(name)
      modelScript.push({
        kind: 'tool_call',
        tool: name,
        args: input,
        reason: typeof input.explanation === 'string' ? input.explanation : '查询信息',
      })
    }
  }

  if (turns.length === 0) turns.push({ userMessage: '请继续处理' })
  if (modelScript.length === 0) {
    modelScript.push({
      kind: 'final',
      answer: lastAssistant || '会话结束',
      escalated: false,
      summary: '草稿缺模型轨迹',
    })
  }

  const uniqueTools = [...new Set(requiredTools)]
  return {
    meta: {
      sourceRunId: run.runId,
      generatedAt: new Date().toISOString(),
      promptVersion: run.promptVersion,
      model: run.model,
      sessionSource: run.source,
      needsReview: ['fixture', 'communicateInfo', 'expectedState', 'modelScript'],
    },
    case: {
      id: `draft_${run.runId}`,
      category: 'regression',
      priority: 'P1',
      description: `由会话 ${run.runId} 生成的回归草稿 夹具与断言需人工核对`,
      fixture: 'baseline',
      actor: { role: 'customer', customerId: run.customerId },
      turns,
      modelScript,
      frozenTime: run.createdAt,
      assertions: {
        expectedState: [
          {
            table: 'agent_runs',
            where: { run_id: '@runId' },
            field: 'status',
            op: 'eq',
            value: run.status,
            note: '运行终态',
          },
        ],
        trajectory: {
          requiredTools: uniqueTools,
          maxToolCalls: Math.max(uniqueTools.length + 2, 3),
        },
      },
    },
  }
}
