/**
 * LLM Judge 回复质量判定
 *
 * 只评主观判据 语气 澄清是否到位 拒绝是否礼貌
 * 判据二元化 实习生测试 仅凭 transcript 可验证
 * judge 模型与被测模型强制分离 输出结构化 JSON
 */

import type { ChatModel } from '@aftersales/agent'
import type { SimJudgeFailure } from '@aftersales/contracts'
import type { JudgeFailure } from './types.js'

export interface JudgeDeps {
  model: ChatModel
  timeoutMs?: number
}

export interface TranscriptTurn {
  role: 'user' | 'agent'
  text: string
}

/**
 * 逐条判定 rubric 返回失败项
 *
 * 单次调用判全部判据 输出 JSON 数组 每项 { rubric, passed, reason }
 * 无法解析输出时判 judge 失败 该项计入用例失败 保证保守
 */
export async function judgeTranscript(
  deps: JudgeDeps,
  rubric: string[],
  transcript: TranscriptTurn[],
): Promise<JudgeFailure[]> {
  if (rubric.length === 0) return []
  if (rubric.some((item) => !item.trim()) || new Set(rubric).size !== rubric.length)
    return [{ rubric: 'judge 判据非法', reason: '判据必须非空且唯一' }]

  const transcriptText = transcript
    .map((turn) => `${turn.role === 'user' ? '顾客' : '客服'} ${turn.text}`)
    .join('\n')

  const system = `你是售后对话质量审核员 依据判据逐条评估客服表现

规则
1 每条判据独立评估 结论只有通过或不通过
2 只依据 transcript 内的对话内容 不得脑补未发生的事
3 未通过的判据给出一句理由 引用或转述对话证据
4 严格输出 JSON 数组 不要输出任何其他文本 格式
[{"rubric":"判据原文","passed":true,"reason":"通过可留空"},{"rubric":"判据原文","passed":false,"reason":"不通过理由"}]
5 reason 内引用或转述对话原文时使用「」或单引号 禁止使用英文双引号 输出必须是合法 JSON 可直接解析`

  const user = `对话记录
${transcriptText}

判据
${rubric.map((item, index) => `${index + 1}. ${item}`).join('\n')}`

  const controller = new AbortController()
  const consume = async () => {
    let raw = ''
    let completed = false
    for await (const event of deps.model.stream(
      {
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        tools: [],
      },
      controller.signal,
    )) {
      controller.signal.throwIfAborted()
      if (event.type === 'text_delta') {
        raw += event.text
      } else if (event.type === 'turn_completed') {
        completed = event.stopReason === 'end_turn'
        break
      }
    }
    return { raw, completed }
  }
  // 超时取消原网关调用并等待观察器与账本收尾后返回
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('Judge timeout'))
      resolve(null)
    }, deps.timeoutMs ?? 10000)
  })
  const consuming = consume().catch((error) => {
    if (!timedOut) throw error
    return null
  })
  const output = await Promise.race([consuming, expired]).finally(() => clearTimeout(timer))
  // 旧非取消适配器保持限时返回 原网关必须等待记账与观察器结束
  if (timedOut && deps.model.supportsCancellation) await consuming
  if (timedOut || !output) return [{ rubric: 'judge 超时', reason: '未获得完整判定' }]
  const { raw, completed } = output
  const parsed = completed ? parseVerdicts(raw) : null
  if (!parsed) {
    return [{ rubric: 'judge 输出无法解析', reason: raw.slice(0, 200) || '空输出' }]
  }
  if (
    parsed.length !== rubric.length ||
    new Set(parsed.map((item) => item.rubric)).size !== rubric.length ||
    parsed.some((item) => !rubric.includes(item.rubric))
  )
    return [{ rubric: 'judge 判据不完整', reason: '判据必须与输入逐项唯一匹配' }]

  const failures: JudgeFailure[] = []
  for (const item of parsed) {
    if (!item.passed) {
      failures.push({ rubric: String(item.rubric), reason: String(item.reason ?? '') })
    }
  }
  return failures
}

interface VerdictItem {
  rubric: string
  passed: boolean
  reason?: string
}

// 严格解析禁止过滤非法条目造成空集合通过
function parseVerdicts(raw: string): VerdictItem[] | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (
      !Array.isArray(value) ||
      !value.every((item: unknown) => {
        if (typeof item !== 'object' || item === null) return false
        const verdict = item as Record<string, unknown>
        return (
          typeof verdict.rubric === 'string' &&
          typeof verdict.passed === 'boolean' &&
          (verdict.reason === undefined || typeof verdict.reason === 'string') &&
          (verdict.passed ||
            (typeof verdict.reason === 'string' && verdict.reason.trim().length > 0))
        )
      })
    )
      return null
    return value as VerdictItem[]
  } catch {
    return null
  }
}

export function toSimJudgeFailures(failures: JudgeFailure[]): SimJudgeFailure[] {
  return failures.map((failure) => ({ rubric: failure.rubric, reason: failure.reason }))
}
