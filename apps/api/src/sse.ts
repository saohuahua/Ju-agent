/**
 * SSE 事件流
 *
 * 事件全部来自持久化事件表 先补发 Last-Event-ID 之后的事件再进入实时轮询
 * 客户端刷新或断线重连都能无损重建时间线 UI 不依赖任何内存状态
 */

import type { EventRepository } from '@aftersales/domain'
import { encodeSseChunk, type AgentEventRow, type EventType } from '@aftersales/contracts'

/** 实时轮询间隔 毫秒 单节点轮询足够 Redis 发布订阅是横向扩展路径 */
const POLL_INTERVAL_MS = 250

/** 运行终态 轮询到达终态并追平事件后关闭流 */

export interface SseDependencies {
  signal?: AbortSignal
  /** 只依赖查询能力 写入永远走领域服务 */
  listEvents: (runId: string, fromSequence: number) => ReturnType<EventRepository['listByRun']>
  isRunTerminal: (runId: string) => Promise<boolean>
  projectEvent?: (event: AgentEventRow) => AgentEventRow | null
  getRunStatus?: (runId: string) => Promise<string>
  /** 测试可缩短轮询间隔 线上保留默认值 */
  pollIntervalMs?: number
  /** 连接最长存活 到期优雅关闭且不发完成帧 以便客户端带 Last-Event-ID 重连 */
  maxLifetimeMs?: number
  onClose?: () => void
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
  let cursor = lastEventId

  const startedAt = Date.now()
  const close = () => {
    if (closed) return
    closed = true
    deps.onClose?.()
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // 初始提示立即返回 避免代理等待首个业务事件
      controller.enqueue(encoder.encode(': connected\n\n'))
    },
    async pull(controller) {
      const send = (chunk: string) => {
        if (!closed) controller.enqueue(encoder.encode(chunk))
      }

      try {
        while (!closed && !deps.signal?.aborted) {
          if (deps.maxLifetimeMs && Date.now() - startedAt >= deps.maxLifetimeMs) {
            send(': server-refresh\n\n')
            break
          }
          const events = await deps.listEvents(runId, cursor + 1)
          if (closed) break
          let deliveredCursor = cursor
          for (const event of events) {
            const visible = deps.projectEvent ? deps.projectEvent(event) : event
            if (visible) {
              send(encodeSseChunk(visible))
              deliveredCursor = event.sequence
            }
            cursor = event.sequence
          }

          // 只发送隐藏批次的水位 不公开原始事件内容
          if (cursor > deliveredCursor) {
            send(
              `id: ${cursor}\nevent: stream.cursor\ndata: ${JSON.stringify({ sequence: cursor })}\n\n`,
            )
          }

          // 每次只交付一个批次 等待消费者继续读取再查下一批
          if (events.length > 0) return

          // 追平且到达终态则收尾
          if (events.length === 0 && (await deps.isRunTerminal(runId))) {
            // 终态检查可能让出执行权 再读一次防止遗漏刚提交的最后事件
            if ((await deps.listEvents(runId, cursor + 1)).length > 0) continue
            const status = await deps.getRunStatus?.(runId)
            send(
              `event: stream.complete\ndata: ${JSON.stringify({ sequence: cursor, status })}\n\n`,
            )
            break
          }
          await sleep(deps.pollIntervalMs ?? POLL_INTERVAL_MS)
        }
      } catch {
        // 轮询异常直接结束流 客户端会重连
      }
      close()
      try {
        controller.close()
      } catch {
        // 消费者取消后不重复关闭
      }
    },
    cancel() {
      close()
    },
  })
}

/** SSE 事件类型重导出 供路由层使用 */
export type { EventType }
