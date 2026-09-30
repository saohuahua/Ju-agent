'use client'

/**
 * 只读展示真实目录事件记录的模型能力
 * 旧运行缺少目录事件时不推导历史能力
 * 工具调用次数只为当前目录中的工具提供补充信息
 */

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { motion, useReducedMotion } from 'framer-motion'
import type { AgentEvent } from '@/lib/types'

/** 工具分组静态清单 与 packages/agent/src/tool-defs.ts 和 TOOL_CATALOG 同步维护 */
const READ_TOOLS = [
  'lookup_customer',
  'list_my_orders',
  'get_order',
  'get_shipment',
  'get_policy',
  'search_policy',
]
const ACTION_TOOLS = [
  'submit_return',
  'submit_refund_only',
  'submit_exchange',
  'cancel_return',
  'compensation',
  'price_protection',
  'escalate',
]
const PROTOCOL_TOOLS = ['ask_user', 'conclude']
const TOOL_LABEL: Record<string, string> = {
  lookup_customer: '查客户',
  list_my_orders: '查询最近订单',
  get_order: '查订单',
  get_shipment: '查物流',
  get_policy: '查政策',
  search_policy: '检索政策',
  submit_return: '退货退款',
  submit_refund_only: '仅退款',
  submit_exchange: '换货',
  cancel_return: '取消售后',
  compensation: '补偿',
  price_protection: '价保',
  escalate: '升级人工',
  ask_user: '提问',
  conclude: '完结',
}

type ToolState = 'visible' | 'gated' | 'called'

interface CatalogView {
  /** 各工具的三态 */
  states: Map<string, ToolState>
  /** 各工具调用次数 */
  calls: Map<string, number>
  /** 当前门控原因说明 */
  gateReason: string
}

/** 从事件流归约目录视图 纯函数 供实时与回放共用 */
function reduceCatalog(events: AgentEvent[]): CatalogView | null {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence)

  // 调用次数来自 tool.requested 动作工具按意图名计 只读与协议工具同名计
  const calls = new Map<string, number>()
  for (const event of sorted) {
    if (event.type === 'tool.requested') {
      const name = String(event.payload.toolName ?? '')
      calls.set(name, (calls.get(name) ?? 0) + 1)
    }
  }

  // 最新一次目录事件 决定可见与门控集合
  let last: AgentEvent | null = null
  for (const event of sorted) {
    if (event.type === 'tools.catalog_changed') last = event
  }

  // 旧运行缺少目录事件时无法证明当时的实际能力范围
  if (!last) return null
  const states = new Map<string, ToolState>()
  const visible = ((last.payload.visible as string[] | undefined) ?? []).map(String)
  const gated = ((last.payload.gated as string[] | undefined) ?? []).map(String)
  for (const name of visible) states.set(name, 'visible')
  for (const name of gated) states.set(name, 'gated')
  return {
    states,
    calls,
    gateReason:
      ((last.payload.reason as string | undefined) ?? '') === 'order_loaded'
        ? '订单已查证 动作工具可供模型选择'
        : '订单尚未查证 动作工具未提供给模型',
  }
}

const STATE_STYLE: Record<ToolState, string> = {
  visible: 'border-sage-200 bg-sage-50 text-sage-900',
  gated: 'border-stone-200 bg-stone-100 text-stone-400',
  called: 'border-blue-200 bg-blue-100 text-blue-900',
}

export function ToolCatalogPanel({ events }: { events: AgentEvent[] }) {
  const catalog = reduceCatalog(events)
  const reducedMotion = useReducedMotion()
  const [open, setOpen] = useState(false)

  if (!catalog) return null
  const listed = new Set(catalog.states.keys())
  const known = new Set([...READ_TOOLS, ...ACTION_TOOLS, ...PROTOCOL_TOOLS])
  const otherTools = [...listed].filter((name) => !known.has(name))

  const renderTool = (name: string) => {
    const callCount = catalog.calls.get(name) ?? 0
    const state: ToolState = callCount > 0 ? 'called' : (catalog.states.get(name) ?? 'gated')
    return (
      <motion.div
        key={name}
        initial={reducedMotion ? false : { opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.25 }}
        title={
          state === 'called'
            ? `${name} 已调用 ${callCount} 次`
            : state === 'visible'
              ? `${name} 当前在模型工具目录中`
              : `${name} 被能力门控挡住 未暴露给模型`
        }
        className={`rounded-badge border px-2 py-1 text-center text-[11px] transition-colors duration-300 ${STATE_STYLE[state]}`}
      >
        <span className="block truncate">{TOOL_LABEL[name] ?? name}</span>
        {callCount > 0 && (
          <span className="font-mono text-[9px] text-blue-800/70">×{callCount}</span>
        )}
      </motion.div>
    )
  }

  return (
    <div className="rounded-container border border-hairline bg-surface">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          <span className="block text-sm font-medium text-stone-700">本次模型工具范围</span>
          <span className="mt-1 block text-xs leading-5 text-stone-500">
            {catalog.gateReason} · 只读记录 · {open ? '收起' : '查看详情'}
          </span>
        </span>
        <ChevronDown
          className={`mt-0.5 size-4 shrink-0 text-stone-500 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="space-y-3 border-t border-hairline px-4 py-3">
          <Group
            title="查询"
            tools={READ_TOOLS.filter((name) => listed.has(name))}
            render={renderTool}
          />
          <Group
            title="售后动作"
            tools={ACTION_TOOLS.filter((name) => listed.has(name))}
            render={renderTool}
          />
          <Group
            title="会话控制"
            tools={PROTOCOL_TOOLS.filter((name) => listed.has(name))}
            render={renderTool}
          />
          <Group title="其他" tools={otherTools} render={renderTool} />
        </div>
      )}
      {open && (
        <div className="flex items-center gap-3 border-t border-hairline px-4 py-2 text-[10px] text-stone-400">
          <Dot className="border-sage-200 bg-sage-50" label="可见" />
          <Dot className="border-stone-200 bg-stone-100" label="门控中" />
          <Dot className="border-blue-200 bg-blue-100" label="已调用" />
        </div>
      )}
    </div>
  )
}

function Group({
  title,
  tools,
  render,
}: {
  title: string
  tools: string[]
  render: (name: string) => React.ReactNode
}) {
  if (tools.length === 0) return null
  return (
    <div>
      <div className="mb-1.5 text-[10px] tracking-wider text-stone-400">{title}</div>
      <div className="grid grid-cols-3 gap-1">{tools.map(render)}</div>
    </div>
  )
}

function Dot({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-badge border ${className}`} />
      {label}
    </span>
  )
}
