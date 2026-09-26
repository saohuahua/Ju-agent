import { randomUUID } from 'node:crypto'
import type { ChatModel, ModelRequest, ModelStreamEvent } from '../../agent/src/model.js'
import {
  P7Error,
  P7Usage,
  type P7Purpose,
  type P7Snapshot,
} from '../../contracts/src/p7-model-gateway.js'
import type { P7Ledger } from '../../persistence/src/p7-ledger.js'
import { p7Cost, p7Reservation, restoreP7Snapshot } from './p7-snapshot.js'
import { decodeP7Stream, encodeP7Request } from './p7-protocol.js'

/** 本阶段只接收离线传输替身 不包含网络实现也不读取环境密钥 */
export interface P7Transport {
  readonly mode: 'simulation'
  stream(body: Record<string, unknown>, signal: AbortSignal): AsyncIterable<unknown>
}

function normalize(error: unknown): P7Error {
  if (error instanceof P7Error) return error
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0
  return new P7Error(
    status === 429 ? 'RATE_LIMITED' : status >= 500 && status <= 599 ? 'UPSTREAM' : 'CONNECTION',
  )
}

/** 一个入口管理所有付费用途 每次尝试独立预占和记账 */
export class P7Gateway {
  readonly snapshot: P7Snapshot
  constructor(
    snapshot: P7Snapshot,
    private readonly ledger: P7Ledger,
  ) {
    this.snapshot = restoreP7Snapshot(snapshot)
  }

  async invoke<T>(
    context: { runId: string; purpose: P7Purpose; operationId?: string; signal?: AbortSignal },
    operation: (signal: AbortSignal, reportUsage: (usage: P7Usage | null) => void) => Promise<T>,
  ): Promise<T> {
    const snapshot = this.snapshot
    if (snapshot.mode !== 'simulation') throw new P7Error('LIVE_DISABLED')
    const reserve = p7Reservation(snapshot)
    const operationId = context.operationId ?? randomUUID()
    for (let attempt = 1; attempt <= snapshot.maxAttempts; attempt++) {
      if (context.signal?.aborted) throw new P7Error('CANCELLED')
      const callId = randomUUID()
      this.ledger.reserve(
        { callId, operationId, runId: context.runId, purpose: context.purpose, attempt },
        snapshot,
        reserve,
      )
      const controller = new AbortController()
      let usage: P7Usage | null = null
      let ended = false
      let rejectAbort: (error: P7Error) => void = () => undefined
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject
      })
      const stop = (code: 'TIMEOUT' | 'CANCELLED') => {
        controller.abort(new P7Error(code))
        rejectAbort(new P7Error(code))
      }
      const cancel = () => stop('CANCELLED')
      context.signal?.addEventListener('abort', cancel, { once: true })
      const timer = setTimeout(() => stop('TIMEOUT'), snapshot.timeoutMs)
      let failure: P7Error | undefined
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => {
            if (controller.signal.aborted) throw controller.signal.reason
            return operation(controller.signal, (value) => {
              // 超时后的迟到响应不能偷偷退回已保留的未知费用
              if (!ended) {
                const parsed = P7Usage.safeParse(value)
                usage = parsed.success ? parsed.data : null
              }
            })
          }),
          aborted,
        ])
        this.ledger.finish(
          callId,
          usage ? p7Cost(snapshot.price!, usage) : null,
          usage,
          'completed',
        )
        return result
      } catch (error) {
        failure = normalize(error)
        // 未知失败包括限流和服务端异常 不能假设供应商从未开始计费
        this.ledger.finish(
          callId,
          usage ? p7Cost(snapshot.price!, usage) : null,
          usage,
          failure.code,
        )
      } finally {
        ended = true
        clearTimeout(timer)
        context.signal?.removeEventListener('abort', cancel)
        controller.abort()
      }
      // 超时和流中断可能留下远端在途请求 不自动重试更不重跑业务工具
      if (
        !failure ||
        !['RATE_LIMITED', 'UPSTREAM'].includes(failure.code) ||
        attempt === snapshot.maxAttempts
      )
        throw failure ?? new P7Error('CONNECTION')
    }
    throw new P7Error('CONNECTION')
  }

  /** 兼容原循环的边界 缺失用量拒绝生成伪造的零用量完成事件 */
  chatModel(
    runId: string,
    purpose: P7Purpose,
    transport: P7Transport,
    signal?: AbortSignal,
    operationId?: string,
  ): ChatModel {
    const snapshot = this.snapshot
    const invoke = this.invoke.bind(this)
    return {
      info: { provider: snapshot.provider, model: snapshot.model },
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        if (transport.mode !== 'simulation') throw new P7Error('LIVE_DISABLED')
        const capturedRequest = globalThis.structuredClone(request)
        const body = encodeP7Request(capturedRequest, snapshot)
        const result = await invoke(
          { runId, purpose, signal, operationId },
          async (attemptSignal, reportUsage) => {
            const response = await decodeP7Stream(
              transport.stream(body, attemptSignal),
              capturedRequest,
              snapshot,
              reportUsage,
            )
            if (!response.usage) throw new P7Error('USAGE_MISSING')
            return { ...response, usage: response.usage }
          },
        )
        // 完整验证后才交付工具事件 避免坏流已经推动业务副作用
        for (const event of result.events) yield event
        yield {
          type: 'turn_completed',
          stopReason: result.stopReason,
          usage: { ...result.usage, costUsd: null },
        }
      },
    }
  }
}
