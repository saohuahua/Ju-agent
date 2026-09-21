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

  let raw = ''
  for await (const event of deps.model.stream({
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    tools: [],
  })) {
    if (event.type === 'text_delta') {
      raw += event.text
    } else if (event.type === 'turn_completed') {
      break
    }
  }

  const parsed = parseVerdicts(raw)
  if (!parsed) {
    return [{ rubric: 'judge 输出无法解析', reason: raw.slice(0, 200) || '空输出' }]
  }

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

/** 宽松解析 JSON 兼容代码围栏与前后缀文本 */
function parseVerdicts(raw: string): VerdictItem[] | null {
  const trimmed = raw.trim()
  const candidates: string[] = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence?.[1]) candidates.unshift(fence[1].trim())
  const first = trimmed.indexOf('[')
  const last = trimmed.lastIndexOf(']')
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as unknown
      if (Array.isArray(obj)) {
        return obj.filter(
          (item): item is VerdictItem =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as VerdictItem).rubric === 'string' &&
            typeof (item as VerdictItem).passed === 'boolean',
        )
      }
    } catch {
      // 尝试下一个候选
    }
  }
  // 兜底 正则逐项提取 兼容 reason 内含未转义双引号的非法 JSON
  // passed 判定保留 reason 截断到首个内嵌引号 保守方向不受影响
  const fallback: VerdictItem[] = []
  const pattern =
    /{\s*"rubric"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"passed"\s*:\s*(true|false)\s*,\s*"reason"\s*:\s*"([\s\S]*?)"(?=\s*[,}])/g
  for (const candidate of candidates) {
    for (const match of candidate.matchAll(pattern)) {
      if (match[1] === undefined || match[2] === undefined) continue
      fallback.push({
        rubric: match[1].replace(/\\"/g, '"'),
        passed: match[2] === 'true',
        reason: (match[3] ?? '').replace(/\\"/g, '"'),
      })
    }
  }
  return fallback.length > 0 ? fallback : null
}

export function toSimJudgeFailures(failures: JudgeFailure[]): SimJudgeFailure[] {
  return failures.map((failure) => ({ rubric: failure.rubric, reason: failure.reason }))
}
