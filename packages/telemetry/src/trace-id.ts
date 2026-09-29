/**
 * OTel 标识派生
 *
 * 同一 runId 必须得到同一 traceId 便于离线重放对照
 * 摘要截断后的十六进制长度符合 OTLP JSON 对 16 字节与 8 字节标识的要求
 */

import { createHash } from 'node:crypto'

/** 32 位十六进制 traceId */
export function otelTraceId(runId: string): string {
  return createHash('sha256').update(`trace:${runId}`).digest('hex').slice(0, 32)
}

/** 16 位十六进制 spanId 输入应含 run 内唯一片段 */
export function otelSpanId(parts: string): string {
  return createHash('sha256').update(`span:${parts}`).digest('hex').slice(0, 16)
}
