/**
 * 可观测导出包
 *
 * 把事件表 工具执行与模型账本映射为 OTLP JSON 并做离线校验
 * 不连接外部 collector
 */

export {
  mapRunToOtlp,
  attrValue,
  type TraceSource,
  type TraceRunRecord,
  type TraceEvent,
  type TraceToolExecution,
  type TraceModelCall,
} from './mapper.js'
export { validateTrace } from './validate.js'
export { OtlpTrace, type OtlpSpan } from './otlp.js'
export { otelTraceId, otelSpanId } from './trace-id.js'
