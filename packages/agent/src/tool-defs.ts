/**
 * 原生工具目录构建
 *
 * 从 contracts 的 Zod 契约生成模型可见的工具定义
 * 只读工具直接执行 action 工具经槽位校验后路由到确定性工作流
 * ask_user 是协议工具 把提问权交给模型 暂停等待用户回复
 */

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { AGENT_TOOLS, INTENT_SLOT_SCHEMAS, ToolIO, TOOL_CATALOG } from '@aftersales/contracts'
import type { Intent, ToolName } from '@aftersales/contracts'
import type { ToolDefinition } from './model.js'

/** 模型可发起的业务动作 工具名即意图名 */
export const ACTION_TOOLS: Intent[] = [
  'submit_return',
  'submit_refund_only',
  'submit_exchange',
  'cancel_return',
  'compensation',
  'price_protection',
  'escalate',
]

export const ASK_USER_TOOL = 'ask_user'

/** 任务完结协议工具 模型显式声明最终答复 结构上区分提问与完结 */
export const CONCLUDE_TOOL = 'conclude'

function describeTool(name: string): string {
  const descriptor = TOOL_CATALOG.find((tool) => tool.name === name)
  return descriptor?.description ?? name
}

function jsonSchema(schema: Parameters<typeof zodToJsonSchema>[0]): Record<string, unknown> {
  const converted = zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' })
  return converted as Record<string, unknown>
}

/** 只读工具定义 目录与白名单同源 */
export function buildReadToolDefinitions(): ToolDefinition[] {
  return AGENT_TOOLS.map((name) => ({
    name: name as string,
    description: describeTool(name),
    inputSchema: jsonSchema(ToolIO[name as ToolName].input),
  }))
}

/** 业务动作工具定义 输入为槽位加发起说明 explanation 与槽位字段解耦 */
export function buildActionToolDefinitions(available: Intent[]): ToolDefinition[] {
  const descriptions: Record<Intent, string> = {
    query_order: '查询订单状态',
    submit_return:
      '发起退货退款申请 客户需寄回商品 原因槽位按客户表述选择 no_reason(不想要了/七天无理由) quality(质量问题) damaged(商品损坏) wrong_item(错发漏发) 系统将执行政策判定与后续流程',
    submit_refund_only:
      '发起仅退款申请 仅适用于无需寄回商品的场景 如未发货取消(unshipped_cancel) 丢件(lost_package) 质量问题(quality) 商品损坏(damaged) 错发漏发(wrong_item) 客户要求退货退钱时不要用本工具 用 submit_return',
    submit_exchange: '发起换货申请',
    cancel_return: '取消已创建的售后申请',
    compensation:
      '发起现金红包补偿 需与顾客确认补偿金额 系统自动执行分级 50 元内自动发放 超出转人工审批 同一订单同一原因仅一次',
    price_protection:
      '发起价保申请 系统对比成交价与当前售价 自签收起 7 天内降价商品按单价差乘数量全额退还 差价金额由系统计算 同一订单仅可价保一次',
    escalate:
      '升级人工客服 将本会话转交人工处理 用户明确要求转人工 情绪激烈反复要求 或订单物流等查询渠道持续故障重试后仍无法完成服务时必须调用 调用前先向客户如实说明升级原因 调用后任务立即转交人工 只在文本中说转接而不调用本工具不生效',
  }
  return available.map((intent) => ({
    name: intent,
    description: descriptions[intent],
    inputSchema: jsonSchema(
      INTENT_SLOT_SCHEMAS[intent].extend({ explanation: z.string() }),
    ),
  }))
}

/** 提问工具定义 模型缺少关键信息时调用 问题会展示给用户并暂停运行 */
export function buildAskUserToolDefinition(): ToolDefinition {
  return {
    name: ASK_USER_TOOL,
    description:
      '向用户提问以补齐缺失信息 一次只问最关键的一项 用户回复后运行继续 仅在信息不足时使用',
    inputSchema: jsonSchema(
      z.object({
        question: z.string().min(1).describe('给用户的提问内容'),
        missingSlot: z.string().min(1).describe('本次提问要补齐的字段名 如 orderNo 或 reason'),
      }),
    ),
  }
}

/** 完结工具定义 模型给出最终答复时显式调用 声明任务结束 */
export function buildConcludeToolDefinition(): ToolDefinition {
  return {
    name: CONCLUDE_TOOL,
    description:
      '任务已完成或已给出最终答复时调用 结束本次售后任务 并附一句话结果摘要 未调用此工具而直接输出文本会被视为等待用户回复',
    inputSchema: jsonSchema(
      z.object({
        summary: z.string().min(1).describe('一句话结果摘要 供运营与审计'),
      }),
    ),
  }
}

/** 单步工具目录 prepareStep 语义 能力门控在调用方决定 action 可见性 */
export function buildStepTools(options: { actions: Intent[] }): ToolDefinition[] {
  return [
    ...buildReadToolDefinitions(),
    ...buildActionToolDefinitions(options.actions),
    buildAskUserToolDefinition(),
    buildConcludeToolDefinition(),
  ]
}

/** 判定工具名归属 */
export function isActionTool(toolName: string): toolName is Intent {
  return ACTION_TOOLS.includes(toolName as Intent)
}
