/**
 * 工具包出口
 *
 * 注册表 执行器 故障控制器 与 Mock 支付网关
 */

export {
  ToolRegistry,
  FaultController,
  ToolExecutionError,
  type ToolContext,
  type ToolDefinition,
  type ToolHandler,
  type FaultPlanEntry,
} from './registry.js'
export { ToolExecutor, ProcessCrashError, type ExecutorDeps } from './executor.js'
export { MockPaymentGateway, type GatewayCallRecord } from './payment-gateway.js'
export { buildToolRegistry, ALL_TOOL_NAMES, type ToolDependencies } from './tool-definitions.js'
