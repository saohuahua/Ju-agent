/**
 * 统一错误对象
 *
 * 全系统只用一种错误形状 携带错误分类与是否可重试标记
 * 工具层抛出 工作流与 Agent 据此决定重试 换路或转人工
 */

import { z } from 'zod'
import { ErrorCode } from './enums.js'

export const ToolErrorShape = z.object({
  code: ErrorCode,
  message: z.string(),
  /** 是否可以原样重试 通常限流与超时可重试 */
  retryable: z.boolean(),
  /** 关联资源 便于审计与排查 */
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
})

export type ToolErrorShape = z.infer<typeof ToolErrorShape>

/** 判断错误码是否默认可重试 */
const RETRYABLE_CODES = new Set<ErrorCode>(['RATE_LIMITED', 'TIMEOUT', 'UPSTREAM_ERROR'])

export function createToolError(
  code: ErrorCode,
  message: string,
  extra?: { resourceType?: string; resourceId?: string },
): ToolErrorShape {
  return {
    code,
    message,
    retryable: RETRYABLE_CODES.has(code),
    ...extra,
  }
}

/** 可重试错误的快速判断函数 */
export function isRetryable(error: ToolErrorShape): boolean {
  return error.retryable
}
