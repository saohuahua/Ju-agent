import { describe, expect, it } from 'vitest'
import { formatToolFeedbackContent, toolFeedbackResults } from '../src/lib/tool-feedback'

describe('工具结果回灌展示', () => {
  it('展开嵌套 JSON 但保留原始结果供核对', () => {
    const payload = {
      results: [
        {
          toolCallId: 'call-1',
          toolName: 'list_my_orders',
          content: '{"orders":[{"orderNo":"SO-1","items":[{"title":"商品"}]}]}',
          isError: false,
        },
      ],
    }
    const results = toolFeedbackResults(payload)
    expect(results?.[0]?.content).toBe(payload.results[0]?.content)
    expect(formatToolFeedbackContent(results![0]!.content)).toContain('\n  "orders": [\n')
    expect(formatToolFeedbackContent(results![0]!.content)).toContain('"title": "商品"')
  })

  it('非 JSON 和错误内容保持原文', () => {
    const content = '工具暂时不可用 请稍后重试'
    const results = toolFeedbackResults({
      results: [{ toolName: 'lookup', content, isError: true }],
    })
    expect(results?.[0]).toMatchObject({ content, isError: true })
    expect(formatToolFeedbackContent(content)).toBe(content)
    expect(toolFeedbackResults({ message: content })).toBeNull()
  })
})
