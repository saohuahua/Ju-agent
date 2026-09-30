import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { api } from './api'
import type { AgentEvent, RunRatingView, RunSummary } from './types'

interface RunDetailSnapshot {
  run: RunSummary
  events: AgentEvent[]
  rating: RunRatingView | null
}

/**
 * 游标从已成功缓存的事件尾部推导 失败和取消都不会推进读取位置
 * 运行编号隔离缓存 身份隔离由上层查询提供器负责
 * 查询库合并同一案件的在途请求 轮询不会与手动刷新堆叠
 */
export function runDetailOptions(client: QueryClient, runId: string) {
  const queryKey = ['run-detail', runId] as const

  return queryOptions({
    queryKey,
    queryFn: async ({ signal }): Promise<RunDetailSnapshot> => {
      const previous = client.getQueryData<RunDetailSnapshot>(queryKey)
      const events = previous?.events ?? []
      const from = (events.at(-1)?.sequence ?? 0) + 1
      const [runBody, eventBody, ratingBody] = await Promise.all([
        api.getRun(runId, signal),
        api.listEvents(runId, from, signal),
        api.getRating(runId, signal).catch((error: unknown) => {
          // 评价暂不可用不遮挡案件详情 取消请求则交由查询库处理
          if (signal.aborted) throw error
          return { rating: null }
        }),
      ])

      return {
        run: runBody.run,
        // 服务端按序号递增返回增量 空响应保留原数组避免重复投影
        events: eventBody.events.length ? [...events, ...eventBody.events] : events,
        rating: ratingBody.rating,
      }
    },
    refetchInterval: (query) =>
      ['running', 'awaiting_approval'].includes(query.state.data?.run.status ?? '') ? 2500 : false,
  })
}
