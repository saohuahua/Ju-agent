/**
 * 评测任务契约
 *
 * 每条用例固定初始快照 用户回合 脚本化模型输出 隐藏约束与终态断言
 * 评测以数据库终态与工具轨迹为准 LLM 判分只用于回复质量 不决定任务成功
 */

import { z } from 'zod'
import { LogisticsEventStatus } from './enums.js'

/** 用例分类 对应调研中的八类风险面 业务新能力单独成类 */
export const EVAL_CATEGORIES = [
  'happy_path',
  'clarification',
  'policy_boundary',
  'approval',
  'rejection',
  'fault_injection',
  'security',
  'recovery',
  'compensation',
  'price_protection',
  'policy_rag',
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
    'compensations',
    'price_protections',
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

/** 用户模拟人设 三档难度 对应 tau2-bench 的 persona 分层 */
export const SIM_PERSONAS = ['normal', 'impatient', 'confused'] as const
export const SimPersona = z.enum(SIM_PERSONAS)
export type SimPersona = z.infer<typeof SimPersona>

/**
 * 模拟客户场景 tau2-bench 风格
 *
 * known 实现选择性信息隐藏 未列出的信息客户不可知 不许编造
 * instructions 是客户的行为剧本 模拟器按剧本即兴发挥
 */
export const UserScenario = z.object({
  persona: SimPersona.default('normal'),
  /** 人设补充描述 如 第三次联系 已不耐烦 */
  personaNotes: z.string().optional(),
  /** 来电原因 客户的目标 */
  reasonForContact: z.string().min(1),
  /** 客户已知信息 未列出的视为不可知 */
  known: z.array(z.string()).default([]),
  /** 行为指令 例如 坚持要退款 若给出明确时限可接受查物流 */
  instructions: z.string().min(1),
  /** 最大对话轮次 超过判失败 */
  maxTurns: z.number().int().positive().default(8),
})
export type UserScenario = z.infer<typeof UserScenario>

export const SimJudgeFailure = z.object({
  rubric: z.string(),
  reason: z.string(),
})
export type SimJudgeFailure = z.infer<typeof SimJudgeFailure>

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
  /** 用户回合顺序输入 Level 1 脚本化回归使用 */
  turns: z.array(z.object({ userMessage: z.string().min(1) })),
  /** 脚本化模型输出 按调用顺序消耗 Level 1 使用 */
  modelScript: z.array(z.record(z.string(), z.unknown())),
  /** 模拟客户场景 Level 2 真实模型评测使用 有 scenario 的用例可跑用户模拟 */
  scenario: UserScenario.optional(),
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
  /**
   * 物流事件注入剧本 与运营端点共用同一注入 API
   * before_first_turn 会话开始前注入 首回合即知晓
   * after_turn 第 turnIndex 轮之后注入 空闲即触达 忙时挂起
   * after_all_turns 全部回合结束后注入 已完结会话不触达
   */
  logisticsEvents: z
    .array(
      z.object({
        at: z.enum(['before_first_turn', 'after_turn', 'after_all_turns']),
        turnIndex: z.number().int().positive().optional(),
        orderNo: z.string(),
        status: LogisticsEventStatus,
        description: z.string(),
        eventId: z.string().optional(),
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
    /** 回复必须说到的关键信息 子串匹配 代码判定 零偏差 */
    communicateInfo: z.array(z.string()).optional(),
    /** 主观项判据 仅此项走 LLM judge 判据须二元可从 transcript 验证 */
    judgeRubric: z.array(z.string()).optional(),
  }),
})
export type EvalCase = z.infer<typeof EvalCase>

/** 用例编写侧类型 带默认值的字段可省略 运行时仍按完整契约校验 */
export type EvalCaseInput = z.input<typeof EvalCase>

/** 单用例执行结果 */
export const FAILURE_KINDS = [
  'state',
  'trajectory',
  'args',
  'escalation',
  'clarify',
  'gateway',
  'communicate',
  'judge',
  'simulator',
  'exception',
] as const
export const FailureKind = z.enum(FAILURE_KINDS)
export type FailureKind = z.infer<typeof FailureKind>

/** 结构化失败明细 判定四层映射 state/gateway→状态层 trajectory/escalation/clarify→轨迹层 args→参数层 communicate/judge→回复质量层 */
export const EvalFailure = z.object({
  kind: FailureKind,
  message: z.string(),
})
export type EvalFailure = z.infer<typeof EvalFailure>

/** 单用例执行结果 */
export const EvalCaseResult = z.object({
  caseId: z.string(),
  category: EvalCategory,
  priority: z.enum(['P0', 'P1', 'P2']),
  passed: z.boolean(),
  failures: z.array(EvalFailure),
  durationMs: z.number().int().nonnegative(),
  /** Level 2 用户模拟的对话轮次 */
  turns: z.number().int().nonnegative().optional(),
  /** 被测 Agent 消耗的 token 与成本 */
  agentInputTokens: z.number().int().nonnegative().optional(),
  agentOutputTokens: z.number().int().nonnegative().optional(),
  agentCostUsd: z.number().optional(),
  /** 用户模拟器消耗的 token 与成本 */
  simulatorInputTokens: z.number().int().nonnegative().optional(),
  simulatorOutputTokens: z.number().int().nonnegative().optional(),
  simulatorCostUsd: z.number().optional(),
  /** LLM judge 判定详情 */
  judge: z.array(SimJudgeFailure).optional(),
  /** L2 运行标识 供前端跳转运行详情时间线回放 */
  runId: z.string().optional(),
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
  /** L1 脚本化回归 或 L2 真实模型加用户模拟 */
  level: z.enum(['L1', 'L2']).default('L1'),
  model: z.string(),
  /** L2 的用户模拟器与 judge 模型 */
  userModel: z.string().optional(),
  judgeModel: z.string().optional(),
  promptVersion: z.string(),
  total: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  passAtK: z.record(z.string(), z.number()).optional(),
  /** Pass^k 全部 k 次都通过的用例比例 */
  passPowerK: z.number().optional(),
  /**
   * Wilson 95% 置信区间 键为指标名（如 task_success_rate passPowerK）
   * 仅 L2 抽样评测计算 L1 脚本回放无采样方差不计算
   */
  confidenceIntervals: z
    .record(z.string(), z.object({ lower: z.number(), upper: z.number() }))
    .optional(),
  metrics: z.record(z.string(), z.number()),
  byCategory: z.record(z.string(), z.object({ total: z.number(), passed: z.number() })),
  caseResults: z.array(EvalCaseResult),
  gatePassed: z.boolean(),
})
export type EvalReport = z.infer<typeof EvalReport>
