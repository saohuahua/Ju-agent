'use client'

/**
 * 决策轨迹泳道时间轴
 *
 * 一次 run 的事件流按泳道（用户/模型/工具/系统/人工）横向展开，
 * 时间从左到右。节点可点击 选中后贯穿全泳道的游标线对齐该时刻，
 * 完整 payload 由父组件在详情抽屉展示。
 *
 * 悬停与选中只用语义 token（bg-surface text-stone-* border-hairline），
 * 深浅两轨自动适配（ADR-013 组件不写死颜色）。
 */

import { LANES, LANE_LABEL, type Lane, type TimelineNode } from '@/lib/timeline'

/** 节点大类的视觉语义 点色与文案色 */
const KIND_DOT: Record<string, string> = {
  'user-message': 'bg-sky-500',
  logistics: 'bg-amber-500',
  'model-text': 'bg-sage-400',
  'model-turn': 'bg-sage-400',
  'tool-call': 'bg-blue-500',
  'tool-result': 'bg-blue-500',
  catalog: 'bg-purple-500',
  guard: 'bg-red-500',
  approval: 'bg-amber-500',
  context: 'bg-emerald-500',
  'run-lifecycle': 'bg-stone-300',
  'human-action': 'bg-violet-500',
}

export interface TimelineProps {
  nodes: TimelineNode[]
  /** 当前选中节点 key */
  selectedKey: string | null
  onSelect: (node: TimelineNode) => void
}

export function Timeline({ nodes, selectedKey, onSelect }: TimelineProps) {
  const byLane = new Map<Lane, TimelineNode[]>()
  for (const lane of LANES) byLane.set(lane, [])
  for (const node of nodes) byLane.get(node.lane)!.push(node)

  const selected = nodes.find((node) => node.key === selectedKey) ?? null

  return (
    <div className="rounded-container border border-hairline bg-surface">
      <div className="flex items-center justify-between border-b border-hairline px-4 py-2.5">
        <h3 className="text-sm font-medium text-stone-700">决策轨迹</h3>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-stone-500">
          <Legend color="bg-sky-500" label="用户" />
          <Legend color="bg-sage-400" label="模型" />
          <Legend color="bg-blue-500" label="工具" />
          <Legend color="bg-purple-500" label="目录" />
          <Legend color="bg-red-500" label="拦截" />
          <Legend color="bg-amber-500" label="审批" />
        </div>
      </div>

      <div className="relative overflow-x-auto px-4 py-3">
        <div className="relative min-w-[640px] space-y-5">
          {selected && (
            // 选中时刻的贯穿游标 对齐所有泳道的同一时间点
            <div
              aria-hidden="true"
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-sage-400/50"
              style={{ left: `calc(${(selected.x * 100).toFixed(2)}% )` }}
            />
          )}
          {LANES.map((lane) => (
            <div key={lane} className="flex items-center gap-3">
              <div className="w-8 shrink-0 text-right text-[10px] tracking-wider text-stone-400">
                {LANE_LABEL[lane]}
              </div>
              <div className="relative h-6 flex-1">
                <div className="absolute top-1/2 right-0 left-0 h-px -translate-y-1/2 bg-hairline" />
                {(byLane.get(lane) ?? []).map((node) => (
                  <button
                    key={node.key}
                    onClick={() => onSelect(node)}
                    title={node.label}
                    aria-label={`${LANE_LABEL[lane]} ${node.label} 事件序 ${node.key.replace('seq-', '')}`}
                    aria-pressed={node.key === selectedKey}
                    className="group absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full focus-visible:outline-2"
                    style={{ left: `${(node.x * 100).toFixed(2)}%` }}
                  >
                    <span
                      className={`block h-2.5 w-2.5 rounded-full transition-transform duration-200 group-hover:scale-150 ${
                        KIND_DOT[node.kind] ?? 'bg-stone-300'
                      } ${
                        node.status === 'failed'
                          ? 'ring-2 ring-red-500/40'
                          : node.key === selectedKey
                            ? 'scale-150 ring-2 ring-sage-500/50'
                            : ''
                      }`}
                    />
                    {/* 工具耗时标注在点上方 悬停可见 title 之外常驻显示关键数字 */}
                    {node.latencyMs !== undefined && (
                      <span className="pointer-events-none absolute bottom-full left-1/2 mb-1 -translate-x-1/2 font-mono text-[9px] whitespace-nowrap text-stone-400 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                        {node.latencyMs}ms
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 选中节点的即时摘要 完整 payload 在详情抽屉 */}
      {selected && (
        <div className="border-t border-hairline px-4 py-2 text-xs text-stone-600">
          <span className="font-mono text-stone-400">#{selected.key.replace('seq-', '')}</span>{' '}
          <span className="text-stone-700">{selected.label}</span>
          {selected.latencyMs !== undefined && (
            <span className="ml-2 font-mono text-stone-400">{selected.latencyMs}ms</span>
          )}
          {selected.events.length > 1 && (
            <span className="ml-2 text-stone-400">含 {selected.events.length} 个事件</span>
          )}
        </div>
      )}
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${color}`} />
      {label}
    </span>
  )
}
