/**
 * OTLP JSON 子集
 *
 * 只覆盖本项目导出用到的字段 不引入 OpenTelemetry SDK
 * 规范快照 2026-09-29 OpenTelemetry GenAI semantic conventions Development
 */

import { z } from 'zod'

export const OtlpAnyValue = z.union([
  z.object({ stringValue: z.string() }),
  z.object({ intValue: z.string() }),
  z.object({ boolValue: z.boolean() }),
  z.object({ doubleValue: z.number() }),
])
export type OtlpAnyValue = z.infer<typeof OtlpAnyValue>

export const OtlpKeyValue = z.object({
  key: z.string().min(1),
  value: OtlpAnyValue,
})
export type OtlpKeyValue = z.infer<typeof OtlpKeyValue>

export const OtlpEvent = z.object({
  timeUnixNano: z.string().min(1),
  name: z.string().min(1),
  attributes: z.array(OtlpKeyValue).default([]),
})
export type OtlpEvent = z.infer<typeof OtlpEvent>

/** 1 INTERNAL 3 CLIENT 与 OTLP SpanKind 枚举一致 */
export const OtlpSpan = z.object({
  traceId: z.string().length(32),
  spanId: z.string().length(16),
  parentSpanId: z.string().length(16).optional(),
  name: z.string().min(1),
  kind: z.union([z.literal(1), z.literal(3)]),
  startTimeUnixNano: z.string().min(1),
  endTimeUnixNano: z.string().min(1),
  attributes: z.array(OtlpKeyValue),
  events: z.array(OtlpEvent).default([]),
  status: z.object({
    code: z.union([z.literal(1), z.literal(2)]),
    message: z.string().optional(),
  }),
})
export type OtlpSpan = z.infer<typeof OtlpSpan>

export const OtlpTrace = z.object({
  resourceSpans: z
    .array(
      z.object({
        resource: z.object({ attributes: z.array(OtlpKeyValue) }),
        scopeSpans: z
          .array(
            z.object({
              scope: z.object({ name: z.string(), version: z.string() }),
              spans: z.array(OtlpSpan).min(1),
            }),
          )
          .min(1),
      }),
    )
    .length(1),
})
export type OtlpTrace = z.infer<typeof OtlpTrace>

export const SPAN_KIND_INTERNAL = 1 as const
export const SPAN_KIND_CLIENT = 3 as const
export const STATUS_OK = 1 as const
export const STATUS_ERROR = 2 as const
