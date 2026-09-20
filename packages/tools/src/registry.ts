/**
 * 工具注册表
 *
 * 每个工具绑定 Zod 输入输出 schema 与处理器
 * 注册表是 Agent 提示词目录 工作流调用与轨迹审计的唯一来源
 * 处理器只依赖领域服务与仓储接口 不直接碰数据库
 */

import type { z } from 'zod'
import {
  ToolIO,
  TOOL_CATALOG,
  findToolDescriptor,
  type ToolDescriptor,
  type ToolName,
} from '@aftersales/contracts'
import type { Actor } from '@aftersales/domain'

/** 工具执行上下文 由调用方组装 */
export interface ToolContext {
  actor: Actor
  runId: string | null
  /** 评测注入的故障控制器 生产环境为空 */
  faults: FaultController | null
}

export type ToolHandler<T extends ToolName = ToolName> = (
  input: z.infer<(typeof ToolIO)[T]['input']>,
  context: ToolContext,
) => Promise<z.infer<(typeof ToolIO)[T]['output']>>

/** 工具定义 描述符加处理器 */
export interface ToolDefinition<T extends ToolName = ToolName> {
  descriptor: ToolDescriptor
  inputSchema: z.ZodTypeAny
  outputSchema: z.ZodTypeAny
  handler: ToolHandler<T>
}

/**
 * 故障控制器
 *
 * 评测专用的确定性故障注入
 * 同一工具前 N 次调用注入指定故障 之后恢复
 * 倒计时在内存中维护 仅评测进程使用
 */
export interface FaultPlanEntry {
  tool: string
  fault: 'timeout' | 'rate_limited' | 'server_error' | 'crash'
  times: number
}

export class FaultController {
  private remaining = new Map<string, number>()

  constructor(plan: FaultPlanEntry[]) {
    for (const entry of plan) {
      this.remaining.set(`${entry.tool}:${entry.fault}`, entry.times)
    }
  }

  /** 取出该工具本次应注入的故障 无故障返回 null */
  consume(tool: string): FaultPlanEntry['fault'] | null {
    const keys = [...this.remaining.keys()].filter(
      (key) => key.startsWith(`${tool}:`) && (this.remaining.get(key) ?? 0) > 0,
    )
    if (keys.length === 0) return null
    const key = keys[0]!
    const left = (this.remaining.get(key) ?? 0) - 1
    if (left <= 0) {
      this.remaining.delete(key)
    } else {
      this.remaining.set(key, left)
    }
    return key.split(':')[1] as FaultPlanEntry['fault']
  }
}

/** 工具执行错误 统一携带契约错误码与可重试标记 */
export class ToolExecutionError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'ToolExecutionError'
  }
}

/** 工具注册表 不可变 注册完成后关闭 */
export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>()

  register<T extends ToolName>(name: T, handler: ToolHandler<T>): void {
    const descriptor = findToolDescriptor(name)
    if (!descriptor) {
      throw new Error(`工具目录中不存在 ${name}`)
    }
    const io = ToolIO[name]
    this.definitions.set(name, {
      descriptor,
      inputSchema: io.input as z.ZodTypeAny,
      outputSchema: io.output as z.ZodTypeAny,
      handler: handler as unknown as ToolHandler,
    })
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name)
  }

  /** 供提示词与文档使用的安全目录 */
  catalog(): readonly ToolDescriptor[] {
    return TOOL_CATALOG
  }

  /** 校验注册完整性 目录中的工具必须全部注册 */
  assertComplete(): void {
    for (const descriptor of TOOL_CATALOG) {
      if (!this.definitions.has(descriptor.name)) {
        throw new Error(`工具未注册 ${descriptor.name}`)
      }
    }
  }
}
