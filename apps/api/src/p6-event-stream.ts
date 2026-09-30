import type { P6TaskRepository } from '../../../packages/persistence/src/p6-task-repository.js'

/**
 * 持久命令进度按确认事件游标重放 仅输出步骤名称与命令状态
 * 原始模型内容工具结果与内部异常不进入该客户流
 * 一次拉取至多一页 消费者断开时停止轮询 未确认片段从未写入事件表
 */
export function p6EventStream(
  repository: P6TaskRepository,
  taskId: string,
  after: number,
): ReadableStream<Uint8Array> {
  let closed = false
  let cursor = after
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'))
    },
    async pull(controller) {
      try {
        while (!closed) {
          const events = repository.events(taskId, cursor)
          if (events.length) {
            for (const event of events) {
              cursor = event.cursor
              const progress = event.eventKey.startsWith('step:')
                ? { step: event.eventKey.slice(5) }
                : event.eventKey.startsWith('status:')
                  ? { status: event.eventKey.slice(7) }
                  : null
              controller.enqueue(
                encoder.encode(
                  progress
                    ? `id: ${cursor}\nevent: task.progress\ndata: ${JSON.stringify({ taskId, ...progress })}\n\n`
                    : `id: ${cursor}\nevent: stream.cursor\ndata: ${JSON.stringify({ cursor })}\n\n`,
                ),
              )
            }
            return
          }
          const task = repository.get(taskId)
          if (!task || !['queued', 'running'].includes(task.status)) {
            // 另一个进程可能刚提交终态事务 关闭前再次追平防止遗漏最后事件
            if (repository.events(taskId, cursor).length > 0) continue
            controller.enqueue(
              encoder.encode(
                `event: stream.complete\ndata: ${JSON.stringify({ cursor, status: task?.status })}\n\n`,
              ),
            )
            controller.close()
            closed = true
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      } catch {
        if (!closed) controller.close()
        closed = true
      }
    },
    cancel() {
      closed = true
    },
  })
}
