/**
 * 政策检索用例 解释政策前先检索语料库 引用条款名与原文作答
 *
 * 检索为关键词确定性打分 召回前三篇 覆盖 干扰条款命中 条款窗口引用 与语料空白如实说明
 */

import type { EvalCaseInput } from '@aftersales/contracts'
import { final, runStatus, toolCall } from './helpers.js'

export const policyRagCases: EvalCaseInput[] = [
  {
    id: 'pr_cite_fresh_food',
    category: 'policy_rag',
    priority: 'P0',
    description: '生鲜退货咨询 检索命中平台条款 引用条款名与原文作答',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '买了一箱水果 想七天无理由退货 咨询生鲜食品的退货政策',
      known: ['刚签收一箱生鲜水果', '听说七天无理由退货可以退', '没有质量问题'],
      instructions: '只是咨询政策 不提供订单号 不要求办理退货 得到明确答复与条款依据后接受 结束',
    },
    turns: [{ userMessage: '生鲜食品可以七天无理由退货吗' }],
    modelScript: [
      toolCall('search_policy', { query: '生鲜商品可以七天无理由退货吗' }),
      final(
        '根据《生鲜食品售后规则》条款 生鲜食品等商品不支持七天无理由退货 签收后因个人原因不支持退换 如有质量问题可在签收后 24 小时内凭照片或视频申请',
        '检索平台条款 生鲜不支持无理由退货',
      ),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'audit_logs',
          where: { action: 'policy_articles_searched' },
          field: 'id',
          op: 'exists',
        },
        {
          table: 'audit_logs',
          where: { action: 'policy_articles_searched' },
          field: 'detail_json',
          op: 'contains',
          value: 'D1_fresh_food_no_return',
          note: '检索留痕包含命中的生鲜条款',
        },
      ],
      trajectory: {
        requiredTools: ['search_policy'],
        toolArgs: [{ tool: 'search_policy', argPath: 'query', op: 'contains', value: '生鲜' }],
      },
      communicateInfo: ['生鲜', '不支持'],
      judgeRubric: ['引用了政策条款名作答', '如实告知生鲜不支持七天无理由退货'],
    },
  },
  {
    id: 'pr_cite_quality_window',
    category: 'policy_rag',
    priority: 'P1',
    description: '质量问题退换窗口咨询 检索命中平台规则 回复引用 15 天窗口',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '买的商品有问题 想咨询质量问题多久内可以退换',
      known: ['商品刚签收', '商品有质量问题', '想知道退换时限'],
      instructions: '只是咨询退换时限 不提供订单号 不要求立即办理 得到明确答复后接受 结束',
    },
    turns: [{ userMessage: '质量问题多久可以退换' }],
    modelScript: [
      toolCall('search_policy', { query: '质量问题多久可以退换' }),
      final(
        '根据《质量问题退换窗口》条款 商品存在质量问题 自签收起 15 天内可申请退货或换货 退货运费由商家承担',
        '检索平台规则 引用质量退换窗口',
      ),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'audit_logs',
          where: { action: 'policy_articles_searched' },
          field: 'detail_json',
          op: 'contains',
          value: 'R3_quality_window',
          note: '检索留痕包含命中的质量窗口条款',
        },
      ],
      trajectory: {
        requiredTools: ['search_policy'],
        toolArgs: [{ tool: 'search_policy', argPath: 'query', op: 'contains', value: '质量' }],
      },
      communicateInfo: ['15'],
      judgeRubric: ['引用了政策条款名作答', '如实告知质量问题退换窗口为 15 天'],
    },
  },
  {
    id: 'pr_no_fabrication',
    category: 'policy_rag',
    priority: 'P0',
    description: '优惠券过期补发咨询 语料无相关条款 如实说明需人工确认 不编造政策',
    actor: { role: 'customer', customerId: 'C1001' },
    scenario: {
      persona: 'normal',
      reasonForContact: '优惠券过期了 想问能不能补发',
      known: ['有一张优惠券过期了没用', '希望平台补发一张'],
      instructions: '询问过期优惠券能否补发 若被告知需人工确认 接受答复即结束 不要求立即转接人工',
    },
    turns: [{ userMessage: '优惠券过期了能补发吗' }],
    modelScript: [
      toolCall('search_policy', { query: '优惠券过期了能补发吗' }),
      final(
        '抱歉 平台政策中未检索到优惠券补发的相关条款 建议您联系人工客服进一步确认',
        '语料无相关条款 转人工确认',
      ),
    ],
    assertions: {
      expectedState: [
        runStatus('completed'),
        {
          table: 'audit_logs',
          where: { action: 'policy_articles_searched' },
          field: 'id',
          op: 'exists',
        },
      ],
      trajectory: { requiredTools: ['search_policy'] },
      communicateInfo: ['人工'],
      judgeRubric: ['未编造政策条款', '如实说明未检索到相关条款需人工确认'],
    },
  },
]
