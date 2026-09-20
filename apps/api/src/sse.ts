/**
 * SSE 事件流
 *
 * 事件全部来自持久化事件表 先补发 Last-Event-ID 之后的事件再进入实时轮询
 * 客户端刷新或断线重连都能无损重建时间线 UI 不依赖任何内存状态
 */

import type { EventRepository } from '@aftersales/domain'
import { encodeSseChunk, type EventType } from '@aftersales/contracts'

/** 实时轮询间隔 毫秒 单节点轮询足够 Redis 发布订阅是横向扩展路径 */
const POLL_INTERVAL_MS = 250

/** 运行终态 轮询到达终态并追平事件后关闭流 */

export interface SseDependencies {
  /** 只依赖查询能力 写入永远走领域服务 */
  listEvents: (runId: string, fromSequence: number) => ReturnType<EventRepository['listByRun']>
  isRunTerminal: (runId: string) => Promise<boolean>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 构建事件流响应
 *
 * lastEventId 为客户端已收到的最后序号 从其之后开始补发
 */
export function createEventStream(
  deps: SseDependencies,
  runId: string,
  lastEventId: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let closed = false

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        if (!closed) controller.enqueue(encoder.encode(chunk))
      }

      // 初始提示 注释行立即返回 避免代理超时
      send(': connected\n\n')

      let cursor = lastEventId
      try {
        for (;;) {
          const events = await deps.listEvents(runId, cursor + 1)
          for (const event of events) {
            send(encodeSseChunk(event as never))
            cursor = event.sequence
          }
          // 追平且到达终态则收尾
          if (events.length === 0 && (await deps.isRunTerminal(runId))) {
            send(': stream-complete\n\n')
            break
          }
          await sleep(POLL_INTERVAL_MS)
        }
      } catch {
        // 轮询异常直接结束流 客户端会重连
      } finally {
        closed = true
        try {
          controller.close()
        } catch {
          // 已关闭
        }
      }
    },
    cancel() {
      closed = true
    },
  })
}

/** SSE 事件类型重导出 供路由层使用 */
export type { EventType }
