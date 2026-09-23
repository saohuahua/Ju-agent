'use client'

/**
 * 副作用三道防线拦截展示
 *
 * 三道闸串联 业务幂等键 → 一次性审批令牌 → 网关级去重
 * 正常请求穿过三道闸 被拦截的请求在对应闸门亮红并展开说明
 * 「拦截即未产生资金动作」——这是幂等三道防线的直接可视化证据
 *
 * 数据来源 guard.blocked 事件（tools 执行器发射）与既有 tool 轨迹
 * 事件缺席（旧运行）时面板如实展示零拦截 三道闸保持静默绿
 */

import type { AgentEvent } from '@/lib/types'

/** 防线定义 与 contracts GuardLayer 一一对应 */
const GUARDS = [
  {
    layer: 'idempotency' as const,
    title: '业务幂等键',
    description: '同一售后单的重复执行请求 按幂等键短路返回首次结果',
  },
  {
    layer: 'approval_token' as const,
    title: '一次性审批令牌',
    description: '高风险路径必须出示有效令牌 令牌一次用后即焚',
  },
  {
    layer: 'gateway' as const,
    title: '网关级去重',
    description: '支付网关按幂等键去重 幂等记录丢失时的最后兜底',
  },
]

const ACTION_LABEL: Record<string, string> = {
  execute_refund: '退款',
  execute_compensation: '补偿',
  execute_price_protection: '价保',
}

interface GuardBlock {
  layer: string
  key: string
  action: string
  /** 拦截发生的事件序号 供跳转时间轴 */
  sequence: number
}

/** 从事件流提取拦截记录 纯函数 */
function extractBlocks(events: AgentEvent[]): GuardBlock[] {
  return events
    .filter((event) => event.type === 'guard.blocked')
    .map((event) => ({
      layer: String(event.payload.layer ?? ''),
      key: String(event.payload.key ?? '-'),
      action: String(event.payload.action ?? ''),
      sequence: event.sequence,
    }))
}

export function GuardPanel({ events }: { events: AgentEvent[] }) {
  const blocks = extractBlocks(events)
  const total = blocks.length

  return (
    <div className="rounded-container border border-hairline bg-surface">
      <div className="flex items-center justify-between border-b border-hairline px-4 py-2.5">
        <h3 className="text-sm font-medium text-stone-700">副作用防线</h3>
        <span className="text-[11px] text-stone-500">
          {total > 0 ? `累计拦截 ${total} 次 · 均未产生资金动作` : '本次运行零拦截'}
        </span>
      </div>

      {/* 三道闸串联 正常请求的流向 */}
      <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-stretch gap-2 px-4 py-4">
        {GUARDS.map((guard, index) => {
          const layerBlocks = blocks.filter((block) => block.layer === guard.layer)
          const blocked = layerBlocks.length > 0
          return (
            <div key={guard.layer} className="contents">
              <div
                className={`rounded-control border px-3 py-2.5 transition-colors duration-300 ${
                  blocked
                    ? 'border-red-200 bg-red-50'
                    : 'border-hairline bg-surface'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-xs font-medium ${blocked ? 'text-red-800' : 'text-stone-700'}`}
                  >
                    {guard.title}
                  </span>
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${
                      blocked ? 'bg-red-500' : 'bg-emerald-500'
                    }`}
                  />
                </div>
                <p className="mt-1 text-[10px] leading-4 text-stone-500">{guard.description}</p>
                <p
                  className={`mt-1 font-mono text-[10px] ${blocked ? 'text-red-700' : 'text-stone-400'}`}
                >
                  {layerBlocks.length > 0 ? `拦截 ${layerBlocks.length} 次` : '放行'}
                </p>
              </div>
              {index < GUARDS.length - 1 && (
                <div className="flex items-center" aria-hidden="true">
                  <span className="text-stone-300">→</span>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* 拦截明细 每条展开被拦下的动作与依据的键 */}
      {blocks.length > 0 && (
        <ul className="divide-y divide-hairline border-t border-hairline">
          {blocks.map((block) => (
            <li key={block.sequence} className="px-4 py-2 text-[11px] leading-5">
              <span className="text-stone-700">
                第 {block.sequence} 号事件 第 {block.key} 请求
              </span>
              <span className="mx-1.5 text-stone-400">·</span>
              <span className="font-mono text-red-700">
                {ACTION_LABEL[block.action] ?? block.action}
              </span>
              <span className="text-stone-500"> 被拦截 未产生资金动作</span>
              <span className="ml-1.5 font-mono text-stone-400">
                {GUARDS.find((guard) => guard.layer === block.layer)?.title ?? block.layer}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
