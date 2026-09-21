/**
 * LLM 政策打分器测试
 *
 * 覆盖关键词预筛 候选上限 零命中短路与解析失败降级
 * 预筛与 KeywordPolicyScorer 同算法 保证生产召回层与评测一致
 */

import { describe, expect, it } from 'vitest'
import type { ChatModel, ModelRequest, ModelStreamEvent } from '../src/model.js'
import { ChatModelPolicyScorer } from '../src/index.js'
import type { PolicyArticle } from '@aftersales/domain'

/** 记录请求内容并回放固定输出的假模型 */
class RecordingModel implements ChatModel {
  readonly info = { provider: 'test', model: 'recording' }
  readonly requests: ModelRequest[] = []

  constructor(private readonly reply: string) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request)
    yield { type: 'text_delta', text: this.reply }
    yield {
      type: 'turn_completed',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
    }
  }
}

function article(articleId: string, title: string, content: string): PolicyArticle {
  return {
    articleId,
    policyVersion: '2026.09-v3',
    title,
    content,
    source: 'rules',
    createdAt: '2026-09-01T00:00:00.000Z',
  }
}

/** 提取发给模型的用户文本 */
function userText(model: RecordingModel): string {
  return model.requests
    .flatMap((request) => request.messages)
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.content)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

describe('关键词预筛', () => {
  it('候选超过 8 篇时只把预筛前 8 交给模型 其余不进请求也不返回', async () => {
    // 9 篇同分候选 按 articleId 升序取前 8 A9 被截断
    const candidates = Array.from({ length: 9 }, (_, i) =>
      article(`A${i + 1}`, '生鲜食品售后规则', '生鲜食品不支持七天无理由退货'),
    )
    // 发票条款与查询无字符重叠 预筛即零分
    const unrelated = article('B1', '发票开具说明', '纸质发票与电子发票申请方式')
    const model = new RecordingModel(
      JSON.stringify([{ articleId: 'A1', score: 7, reason: '直接相关' }]),
    )
    const scorer = new ChatModelPolicyScorer(model)
    const scores = await scorer.score('生鲜食品可以退货吗', [...candidates, unrelated])

    expect(model.requests).toHaveLength(1)
    const sent = userText(model)
    expect(sent).toContain('A1')
    expect(sent).toContain('A8')
    expect(sent).not.toContain('A9')
    expect(sent).not.toContain('B1')
    expect(scores.map((item) => item.articleId)).toEqual(['A1'])
  })

  it('候选不超过 8 篇时全量交给模型', async () => {
    const articles = [
      article('R1', '退款时效规则', '平台受理后三个工作日内原路退回'),
      article('R2', '换货时效规则', '签收后十五天内可申请换货'),
      article('R3', '发票规则', '订单完成后可申请电子发票'),
    ]
    const model = new RecordingModel(
      JSON.stringify([
        { articleId: 'R2', score: 8, reason: '换货窗口相关' },
        { articleId: 'R1', score: 2, reason: '弱相关' },
      ]),
    )
    const scorer = new ChatModelPolicyScorer(model)
    const scores = await scorer.score('质量问题多久可以退换', articles)

    expect(model.requests).toHaveLength(1)
    const sent = userText(model)
    expect(sent).toContain('R1')
    expect(sent).toContain('R2')
    expect(sent).toContain('R3')
    expect(scores.map((item) => item.articleId)).toEqual(['R2', 'R1'])
  })

  it('关键词零命中时短路 不调用模型', async () => {
    const model = new RecordingModel('[]')
    const scorer = new ChatModelPolicyScorer(model)
    const scores = await scorer.score('优惠券过期了能补发吗', [
      article('R1', '生鲜食品售后规则', '生鲜食品不支持七天无理由退货'),
    ])

    expect(model.requests).toHaveLength(0)
    expect(scores).toEqual([])
  })

  it('模型输出解析失败时降级为空 不抛出', async () => {
    const model = new RecordingModel('抱歉 我无法回答这个问题')
    const scorer = new ChatModelPolicyScorer(model)
    const scores = await scorer.score('生鲜食品可以退货吗', [
      article('A1', '生鲜食品售后规则', '生鲜食品不支持七天无理由退货'),
    ])

    expect(model.requests).toHaveLength(1)
    expect(scores).toEqual([])
  })

  it('语料为空时直接返回空 不调用模型', async () => {
    const model = new RecordingModel('[]')
    const scorer = new ChatModelPolicyScorer(model)
    expect(await scorer.score('生鲜食品可以退货吗', [])).toEqual([])
    expect(model.requests).toHaveLength(0)
  })
})
