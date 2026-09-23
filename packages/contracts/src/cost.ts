/**
 * 运行成本契约
 *
 * 每次运行的 token 用量 耗时与估算成本 是生产系统的必备可观测项
 * 也是首屏驾驶舱累计成本数字的数据源
 *
 * 诚实纪律（项目既定）：脚本化模型的 token 是估算值 真实模型的是 API 实测值
 * 两者永不混算 source 字段把口径写进数据本身 而不是靠调用方记得区分
 */

import { z } from 'zod'

/**
 * token 计量口径
 *
 * measured  真实模型 API 响应 usage 字段的实测值
 * estimated 脚本化模型 由 estimateTokens() 按字符数估算 仅证明系统层正确性
 */
export const TOKEN_SOURCES = ['measured', 'estimated'] as const
export const TokenSource = z.enum(TOKEN_SOURCES)
export type TokenSource = z.infer<typeof TokenSource>

/** 单次模型调用的用量 一次运行包含多轮 按轮累加得到运行总量 */
export const ModelUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** 命中提示词缓存的输入 token 计费显著低于普通输入 故单列 */
  cacheReadTokens: z.number().int().nonnegative().default(0),
})
export type ModelUsage = z.infer<typeof ModelUsage>

/**
 * 运行成本视图 按 runId 聚合
 *
 * estimatedCostCents 用分为单位与全系统金额口径一致 避免浮点累加误差
 * 定价表随模型变动 取数时间与来源在 pricing 模块注明 不在这里写死
 */
export const RunCost = z.object({
  runId: z.string(),
  model: z.string(),
  source: TokenSource,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  /** 模型调用轮次 用于判断成本是被长会话还是被单轮长上下文推高 */
  turns: z.number().int().nonnegative(),
  estimatedCostCents: z.number().int().nonnegative(),
  /** 运行墙钟耗时 含工具执行与审批等待 */
  durationMs: z.number().int().nonnegative(),
})
export type RunCost = z.infer<typeof RunCost>
