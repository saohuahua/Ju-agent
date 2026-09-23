'use client'

/**
 * 工具目录与能力门控实时状态
 *
 * 三组工具按「模型可见性」分层：
 *   只读    永远可见 查证类
 *   动作    受能力门控 未查过订单前不进模型目录（escalate 例外 它是通道工具）
 *   协议    ask_user / conclude 永远可见
 *   工作流侧 模型永远看不到 由确定性工作流调用 —— 资金动作的结构性隔离
 *
 * 三态渲染：可见（在目录里）/ 门控中（存在但被挡）/ 已调用（显示次数）。
 * 当 get_order 成功后动作工具从门控翻转为可见 这一刻的翻转动画
 * 把「能力门控 结构性防盲提交」从文案变成看得见的机制。
 *
 * 数据来源 tools.catalog_changed 事件；旧运行没有该事件时按
 * get_order 是否成功回退推导 面板如实标注推导口径。
 */

import { motion, useReducedMotion } from 'framer-motion'
import type { AgentEvent } from '@/lib/types'

/** 工具分组静态清单 与 packages/agent/src/tool-defs.ts 和 TOOL_CATALOG 同步维护 */
const READ_TOOLS = ['lookup_customer', 'get_order', 'get_shipment', 'get_policy', 'search_policy']
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
/** 工作流侧工具 模型永不可见 由确定性工作流调用 资金动作在这里被结构性隔离 */
const WORKFLOW_TOOLS = [
  'create_return_request',
  'cancel_return_request',
  'execute_refund',
  'create_compensation',
  'execute_compensation',
  'create_price_protection',
  'execute_price_protection',
  'record_return_shipment',
  'receive_return_goods',
  'escalate_to_human',
]

const TOOL_LABEL: Record<string, string> = {
  lookup_customer: '查客户',
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
  create_return_request: '建退货单',
  cancel_return_request: '撤退货单',
  execute_refund: '执行退款',
  create_compensation: '建补偿单',
  execute_compensation: '执行补偿',
  create_price_protection: '建价保单',
  execute_price_protection: '执行价保',
  record_return_shipment: '登记寄回',
  receive_return_goods: '收货确认',
  escalate_to_human: '升级落审计',
}

type ToolState = 'visible' | 'gated' | 'called'

interface CatalogView {
  /** 各工具的三态 */
  states: Map<string, ToolState>
  /** 各工具调用次数 */
  calls: Map<string, number>
  /** 数据口径 事件实测或推导 */
  derived: boolean
  /** 当前门控原因说明 */
  gateReason: string
}

/** 从事件流归约目录视图 纯函数 供实时与回放共用 */
function reduceCatalog(events: AgentEvent[]): CatalogView {
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

  const states = new Map<string, ToolState>()
  if (last) {
    const visible = ((last.payload.visible as string[] | undefined) ?? []).map(String)
    const gated = ((last.payload.gated as string[] | undefined) ?? []).map(String)
    for (const name of visible) states.set(name, 'visible')
    for (const name of gated) states.set(name, 'gated')
    return {
      states,
      calls,
      derived: false,
      gateReason:
        ((last.payload.reason as string | undefined) ?? '') === 'order_loaded'
          ? '订单已查证 动作工具解禁'
          : '未查过订单 动作工具不进模型目录',
    }
  }

  // 旧运行无目录事件 按 get_order 成功与否推导 面板标注推导口径
  const orderLoaded = sorted.some(
    (event) =>
      event.type === 'tool.completed' &&
      (event.payload as { toolName?: string }).toolName === 'get_order' &&
      (event.payload as { status?: string }).status === 'succeeded',
  )
  for (const name of [...READ_TOOLS, ...PROTOCOL_TOOLS]) states.set(name, 'visible')
  for (const name of ACTION_TOOLS) states.set(name, orderLoaded ? 'visible' : 'gated')
  return {
    states,
    calls,
    derived: true,
    gateReason: orderLoaded ? '订单已查证（推导）' : '未查过订单（推导）',
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
      <div className="border-b border-hairline px-4 py-2.5">
        <h3 className="text-sm font-medium text-stone-700">工具目录 · 能力门控</h3>
        <p className="mt-0.5 text-[11px] leading-4 text-stone-500">
          {catalog.gateReason}
          {catalog.derived && ' · 旧运行无目录事件 按查单结果推导'}
        </p>
      </div>
      <div className="space-y-3 px-4 py-3">
        <Group title="只读" tools={READ_TOOLS} render={renderTool} />
        <Group title="动作（门控）" tools={ACTION_TOOLS} render={renderTool} />
        <Group title="协议" tools={PROTOCOL_TOOLS} render={renderTool} />
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] tracking-wider text-stone-400">工作流侧 · 模型永不可见</span>
            <span className="text-[10px] text-stone-400">资金动作在此隔离</span>
          </div>
          <div className="grid grid-cols-2 gap-1">
            {WORKFLOW_TOOLS.map((name) => (
              <div
                key={name}
                title={`${name} 只由确定性工作流调用 模型目录里永远没有它`}
                className="rounded-badge border border-dashed border-stone-200 px-2 py-1 text-center text-[11px] text-stone-400"
              >
                <span className="block truncate">{TOOL_LABEL[name] ?? name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-hairline px-4 py-2 text-[10px] text-stone-400">
        <Dot className="border-sage-200 bg-sage-50" label="可见" />
        <Dot className="border-stone-200 bg-stone-100" label="门控中" />
        <Dot className="border-blue-200 bg-blue-100" label="已调用" />
        <Dot className="border-dashed border-stone-200" label="工作流侧" />
      </div>
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
