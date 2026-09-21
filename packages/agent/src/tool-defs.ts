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
  'escalate',
]

export const ASK_USER_TOOL = 'ask_user'

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
    submit_return: '发起退货退款申请 系统将执行政策判定与后续流程',
    submit_refund_only: '发起仅退款申请 适用未发货取消或丢件等场景',
    submit_exchange: '发起换货申请',
    cancel_return: '取消已创建的售后申请',
    escalate: '升级人工客服',
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

/** 单步工具目录 prepareStep 语义 能力门控在调用方决定 action 可见性 */
export function buildStepTools(options: { actionsAvailable: boolean }): ToolDefinition[] {
  const actions = options.actionsAvailable ? ACTION_TOOLS : []
  return [
    ...buildReadToolDefinitions(),
    ...buildActionToolDefinitions(actions),
    buildAskUserToolDefinition(),
  ]
}

/** 判定工具名归属 */
export function isActionTool(toolName: string): toolName is Intent {
  return ACTION_TOOLS.includes(toolName as Intent)
}
