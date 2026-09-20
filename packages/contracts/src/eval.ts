/**
 * 评测任务契约
 *
 * 每条用例固定初始快照 用户回合 脚本化模型输出 隐藏约束与终态断言
 * 评测以数据库终态与工具轨迹为准 LLM 判分只用于回复质量 不决定任务成功
 */

import { z } from 'zod'

/** 用例分类 对应调研中的八类风险面 */
export const EVAL_CATEGORIES = [
  'happy_path',
  'clarification',
  'policy_boundary',
  'approval',
  'rejection',
  'fault_injection',
  'security',
  'recovery',
] as const
export const EvalCategory = z.enum(EVAL_CATEGORIES)
export type EvalCategory = z.infer<typeof EvalCategory>

/** 数据库终态断言 判定成功的核心证据 */
export const StateAssertion = z.object({
  table: z.enum([
    'orders',
    'shipments',
    'return_requests',
    'refunds',
    'approval_requests',
    'audit_logs',
    'tool_executions',
    'agent_runs',
    'agent_events',
  ]),
  /** 行过滤条件 精确匹配字段 特殊值 @runId 由评测器替换为实际运行标识 */
  where: z.record(z.string(), z.unknown()).optional(),
  field: z.string(),
  op: z.enum(['eq', 'ne', 'exists', 'missing', 'count', 'contains', 'not_contains']),
  value: z.unknown().optional(),
  /** 断言失败时的可读说明 */
  note: z.string().optional(),
})
export type StateAssertion = z.infer<typeof StateAssertion>

/** 工具参数断言 支持取 args 内嵌套字段 */
export const ToolArgAssertion = z.object({
  tool: z.string(),
  /** 点路径访问 args 如 orderNo 或 items 0 itemId */
  argPath: z.string(),
  op: z.enum(['eq', 'ne']),
  value: z.unknown(),
})
export type ToolArgAssertion = z.infer<typeof ToolArgAssertion>

/** 轨迹断言 */
export const TrajectoryAssertions = z.object({
  /** 必须被调用的工具 集合语义 不要求顺序 */
  requiredTools: z.array(z.string()).optional(),
  /** 禁止被调用的工具 */
  forbiddenTools: z.array(z.string()).optional(),
  /** 有序子序列 工具名按顺序出现 */
  orderedSubsequence: z.array(z.string()).optional(),
  /** 工具参数精确断言 */
  toolArgs: z.array(ToolArgAssertion).optional(),
  /** 执行次数上限 违反视为无效循环 */
  maxToolCalls: z.number().int().positive().optional(),
})
export type TrajectoryAssertions = z.infer<typeof TrajectoryAssertions>

/** 故障注入计划 */
export const FaultPlan = z.object({
  tool: z.string(),
  /** 故障类型 timeout 模拟工具超时 rate_limited 模拟限流 server_error 模拟上游故障 crash 模拟进程中断 */
  fault: z.enum(['timeout', 'rate_limited', 'server_error', 'crash']),
  /** 前几次调用注入故障 之后恢复正常 */
  times: z.number().int().positive().default(1),
})
export type FaultPlan = z.infer<typeof FaultPlan>

/** 单条评测用例 */
export const EvalCase = z.object({
  id: z.string().min(1),
  category: EvalCategory,
  priority: z.enum(['P0', 'P1', 'P2']),
  description: z.string().min(1),
  /** 基础夹具名 */
  fixture: z.string().default('baseline'),
  /** 夹具补丁 在基础数据上做定向覆盖 */
  fixturePatch: z
    .array(
      z.object({
        table: z.string(),
        where: z.record(z.string(), z.unknown()),
        set: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  /** 发起身份 客户身份会触发归属校验 */
  actor: z.object({
    role: z.enum(['customer', 'operator', 'supervisor']),
    customerId: z.string().optional(),
  }),
  /** 用户回合顺序输入 */
  turns: z.array(z.object({ userMessage: z.string().min(1) })),
  /** 脚本化模型输出 按调用顺序消耗 */
  modelScript: z.array(z.record(z.string(), z.unknown())),
  faultPlan: z.array(FaultPlan).optional(),
  /** 审批环节的处理方式 approve reject 或等待过期 */
  approvalAction: z.enum(['approve', 'reject', 'expire']).optional(),
  /** 运行结束后按顺序执行的运营动作 用于演示收货等闭环 */
  operatorActions: z
    .array(
      z.object({
        tool: z.enum(['record_return_shipment', 'receive_return_goods']),
        args: z.record(z.string(), z.unknown()),
        /** 执行身份 customer 或 operator */
        role: z.enum(['customer', 'operator']),
      }),
    )
    .optional(),
  /** 冻结时钟 ISO 时间 缺省使用夹具默认时间 */
  frozenTime: z.string().optional(),
  maxSteps: z.number().int().positive().default(12),
  assertions: z.object({
    expectedState: z.array(StateAssertion),
    trajectory: TrajectoryAssertions.optional(),
    expectEscalation: z.boolean().optional(),
    expectClarify: z.boolean().optional(),
    /** 幂等专项断言 网关成功扣款次数 */
    expectGatewayCharges: z.number().int().nonnegative().optional(),
  }),
})
export type EvalCase = z.infer<typeof EvalCase>

/** 用例编写侧类型 带默认值的字段可省略 运行时仍按完整契约校验 */
export type EvalCaseInput = z.input<typeof EvalCase>

/** 单用例执行结果 */
export const EvalCaseResult = z.object({
  caseId: z.string(),
  category: EvalCategory,
  priority: z.enum(['P0', 'P1', 'P2']),
  passed: z.boolean(),
  failures: z.array(z.string()),
  durationMs: z.number().int().nonnegative(),
})
export type EvalCaseResult = z.infer<typeof EvalCaseResult>

/** 指标键 与调研文档的评测四层对应 */
export const METRIC_KEYS = [
  'task_success_rate',
  'side_effect_correctness',
  'tool_selection_accuracy',
  'tool_argument_accuracy',
  'policy_violation_rate',
  'duplicate_side_effect_rate',
  'checkpoint_recovery_rate',
  'injection_defense_rate',
  'clarification_quality',
  'escalation_correctness',
] as const
export type MetricKey = (typeof METRIC_KEYS)[number]

/** 评测报告 */
export const EvalReport = z.object({
  reportId: z.string(),
  startedAt: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  total: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  passAtK: z.record(z.string(), z.number()).optional(),
  /** Pass^k 全部 k 次都通过的用例比例 */
  passPowerK: z.number().optional(),
  metrics: z.record(z.string(), z.number()),
  byCategory: z.record(z.string(), z.object({ total: z.number(), passed: z.number() })),
  caseResults: z.array(EvalCaseResult),
  gatePassed: z.boolean(),
})
export type EvalReport = z.infer<typeof EvalReport>
