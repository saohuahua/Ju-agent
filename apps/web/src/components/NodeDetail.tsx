'use client'

/**
 * 时间轴节点详情
 *
 * 展示选中节点关联的全部原始事件 payload。
 * 工具节点额外展示流式入参逐帧原文（tool.input.delta 的每一片），
 * 「模型边想边写参数」的过程由此可逐帧回看。
 */

import { useState } from 'react'
import type { TimelineNode } from '@/lib/timeline'
import { formatToolFeedbackContent, toolFeedbackResults } from '@/lib/tool-feedback'

const EVENT_TYPE_LABEL: Record<string, string> = {
  'run.started': '运行开始',
  'message.user': '用户消息',
  'message.delta': '流式片段',
  'message.completed': '回复完成',
  'agent.output': '模型输出',
  'agent.turn': '模型轮次',
  'agent.tool_results': '工具结果回灌',
  'tool.input.delta': '工具参数流式',
  'context.compacted': '上下文压缩',
  'step.started': '步骤开始',
  'step.completed': '步骤完成',
  'tool.requested': '工具调用',
  'tool.completed': '工具结果',
  'approval.required': '需要审批',
  'approval.decided': '审批决定',
  'logistics.event': '物流事件',
  'run.paused': '运行暂停',
  'run.resumed': '运行恢复',
  'run.failed': '运行失败',
  'run.completed': '运行完成',
  'run.escalated': '升级人工',
  'run.handover': '坐席接管',
  'operator.message': '坐席消息',
  'run.resolved': '坐席标记解决',
  'tools.catalog_changed': '工具目录变更',
  'guard.blocked': '防线拦截',
}

export function NodeDetail({ node }: { node: TimelineNode | null }) {
  // 模式与换行只改变本地展示 不修改时间轴事件和原始载荷
  // 切换节点时保留阅读偏好 便于连续比对多次工具回灌
  const [view, setView] = useState<'formatted' | 'raw'>('formatted')
  const [wrap, setWrap] = useState(true)

  if (!node) {
    return (
      <div className="flex h-full min-h-40 items-center justify-center rounded-container border border-dashed border-hairline text-xs text-stone-400">
        点击时间轴节点查看完整事件详情
      </div>
    )
  }

  const hasFeedback = node.events.some((event) => event.type === 'agent.tool_results')
  const codeClass = `rounded-control border border-hairline bg-stone-100 px-3 py-2 font-mono text-[11px] leading-5 text-stone-700 overflow-x-auto ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`

  return (
    <div className="rounded-container border border-hairline bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-2.5">
        <h3 className="text-sm font-medium text-stone-700">{node.label}</h3>
        <span className="font-mono text-[10px] text-stone-400">
          #{node.key.replace('seq-', '')}
          {node.latencyMs !== undefined && ` · ${node.latencyMs}ms`}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-2">
        {hasFeedback ? (
          <div
            role="group"
            aria-label="结果展示方式"
            className="inline-flex rounded-control border border-hairline p-0.5 text-xs"
          >
            <button
              type="button"
              aria-pressed={view === 'formatted'}
              onClick={() => setView('formatted')}
              className="rounded-control px-2.5 py-1 aria-pressed:bg-accent aria-pressed:text-ink"
            >
              格式化
            </button>
            <button
              type="button"
              aria-pressed={view === 'raw'}
              onClick={() => setView('raw')}
              className="rounded-control px-2.5 py-1 aria-pressed:bg-accent aria-pressed:text-ink"
            >
              原始 JSON
            </button>
          </div>
        ) : (
          <span />
        )}
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-stone-600">
          <input
            type="checkbox"
            checked={wrap}
            onChange={(event) => setWrap(event.target.checked)}
            className="accent-primary"
          />
          自动换行
        </label>
      </div>

      <div className="max-h-96 space-y-3 overflow-y-auto px-4 py-3">
        {node.inputFrames && node.inputFrames.length > 0 && (
          <section>
            <h4 className="mb-1.5 text-[10px] tracking-wider text-stone-400">
              流式入参 · {node.inputFrames.length} 帧
            </h4>
            <div className="flex flex-wrap gap-1">
              {node.inputFrames.map((frame, index) => (
                <code
                  key={index}
                  className="rounded-badge border border-hairline bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] text-stone-600"
                >
                  {frame || '∅'}
                </code>
              ))}
            </div>
            <p className="mt-1.5 font-mono text-[11px] break-all text-stone-600">
              拼接结果 {node.inputFrames.join('')}
            </p>
          </section>
        )}

        {node.events.map((event) => {
          const results =
            event.type === 'agent.tool_results' ? toolFeedbackResults(event.payload) : null
          return (
            <section key={event.sequence}>
              <h4 className="mb-1 flex items-center gap-2 text-[10px] tracking-wider text-stone-400">
                {EVENT_TYPE_LABEL[event.type] ?? event.type}
                <span className="font-mono">seq {event.sequence}</span>
                <span>{new Date(event.createdAt).toLocaleTimeString('zh-CN')}</span>
              </h4>
              {view === 'formatted' && results ? (
                <div className="space-y-3">
                  {results.map((result, index) => (
                    <article
                      key={`${result.toolCallId}-${index}`}
                      className="min-w-0 overflow-hidden rounded-control border border-hairline bg-white"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-3 py-2">
                        <div className="min-w-0">
                          <strong className="block break-all font-mono text-xs text-stone-800">
                            {result.toolName}
                          </strong>
                          {result.toolCallId && (
                            <span className="block break-all font-mono text-[10px] text-stone-500">
                              {result.toolCallId}
                            </span>
                          )}
                        </div>
                        <span
                          className={
                            result.isError ? 'text-xs text-red-700' : 'text-xs text-emerald-700'
                          }
                        >
                          {result.isError ? '执行失败' : '执行成功'}
                        </span>
                      </div>
                      <pre className={`${codeClass} rounded-none border-0 bg-transparent`}>
                        {formatToolFeedbackContent(result.content)}
                      </pre>
                    </article>
                  ))}
                </div>
              ) : (
                <pre className={codeClass}>{JSON.stringify(event.payload, null, 2)}</pre>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
