import type { ChatModel, ModelStreamEvent } from '../../../agent/src/model.js'
import type { P7Config } from '../../../contracts/src/p7-model-gateway.js'
import type { P7Transport } from '../../../runtime/src/p7-gateway.js'
import { createP7Snapshot } from '../../../runtime/src/p7-snapshot.js'
import { config, frames, streamFrames } from '../../../runtime/test/p7-fixtures.js'
import type { P7EvalRole, P7EvalRoleConfig } from '../../src/p7-eval-models.js'

/** 只回放既有协议夹具 不创建网络客户端 */
export function offline(protocol: P7Config['protocol'] = 'openai_chat', text = '我要查询订单') {
  const calls: Array<{ body: Record<string, unknown>; signal: AbortSignal }> = []
  const transport: P7Transport = {
    mode: 'simulation',
    stream(body, signal) {
      calls.push({ body, signal })
      return streamFrames(frames(protocol, { text }))
    },
  }
  return { transport, calls }
}

/** 固定人工每次价格使预算断言不依赖模型文本长度 */
export function roleConfig(
  role: P7EvalRole,
  transport: P7Transport,
  fixedMicroPerCall = 10,
  overrides: Partial<P7Config> = {},
): P7EvalRoleConfig {
  const base = config()
  return {
    transport,
    snapshot: createP7Snapshot(
      config({
        protocol: 'openai_chat',
        model: `offline-${role}`,
        price: {
          ...base.price!,
          version: `synthetic-${role}`,
          inputMicroPerMillion: 0,
          outputMicroPerMillion: 0,
          fixedMicroPerCall,
        },
        ...overrides,
      }),
    ),
  }
}

export const scenario = {
  persona: 'normal' as const,
  reasonForContact: '查询订单',
  known: [],
  instructions: '询问物流',
  maxTurns: 2,
}

/** 完整消费被测模型流 保留美元未知值用于断言 */
export async function consume(model: ChatModel): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of model.stream({ system: '离线评测', messages: [], tools: [] }))
    events.push(event)
  return events
}

/** 显式屏障保持预占中的请求 取消由真实网关信号传入 */
export function pendingTransport() {
  let started!: () => void
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: AbortSignal[] = []
  const transport: P7Transport = {
    mode: 'simulation',
    async *stream(_body, signal) {
      calls.push(signal)
      started()
      await new Promise<void>((resolve) => {
        const abort = () => resolve()
        signal.addEventListener('abort', abort, { once: true })
        void pending.then(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        })
      })
      yield* frames('openai_chat', { text: '离线回复' })
    },
  }
  return { transport, calls, ready, release }
}
