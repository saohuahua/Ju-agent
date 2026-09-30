export interface ToolFeedbackResult {
  toolCallId: string
  toolName: string
  isError: boolean
  content: string
}

/**
 * 回灌事件的 content 是字符串 其中可能再次编码了 JSON
 * 只解析用于展示的副本 保留事件原始载荷供原始视图核对
 * 非 JSON 文本和合法的字符串值按原文展示 避免把说明文字误当成对象
 */
export function formatToolFeedbackContent(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed === 'object' && parsed !== null) {
      return JSON.stringify(parsed, null, 2)
    }
  } catch {
    // 普通文本不是解析错误 原样展示即可
  }
  return content
}

/**
 * 无法识别的载荷交给原始视图展示 不丢弃服务端提供的字段
 * 单条结果缺少可选名称时仍保留内容和错误状态
 */
export function toolFeedbackResults(payload: Record<string, unknown>): ToolFeedbackResult[] | null {
  if (!Array.isArray(payload.results)) return null
  return payload.results.map((item) => {
    const result = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    return {
      toolCallId: typeof result.toolCallId === 'string' ? result.toolCallId : '',
      toolName: typeof result.toolName === 'string' ? result.toolName : '未命名工具',
      isError: result.isError === true,
      content:
        typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? ''),
    }
  })
}
