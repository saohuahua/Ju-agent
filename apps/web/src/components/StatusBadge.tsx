/**
 * 状态徽章
 *
 * 运行状态与审批状态的统一视觉映射
 * 视觉规范：muted pastel 浅底 + 深字 + 细边（docs/redesign-audit.md 4.1）
 */

import type { RunStatus } from '@/lib/types'

const RUN_STATUS_STYLE: Record<RunStatus, { label: string; className: string }> = {
  created: {
    label: '已创建',
    className: 'border-stone-200 bg-stone-100 text-stone-600',
  },
  running: {
    label: '执行中',
    className: 'border-sky-200 bg-sky-50 text-sky-800',
  },
  awaiting_input: {
    label: '等待补充信息',
    className: 'border-amber-200 bg-amber-50 text-amber-800',
  },
  awaiting_approval: {
    label: '等待审批',
    className: 'border-orange-200 bg-orange-50 text-orange-800',
  },
  completed: {
    label: '已完成',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  },
  failed: {
    label: '失败',
    className: 'border-red-200 bg-red-50 text-red-800',
  },
  cancelled: {
    label: '已取消',
    className: 'border-stone-200 bg-stone-100 text-stone-500',
  },
  escalated: {
    label: '已升级人工',
    className: 'border-purple-200 bg-purple-50 text-purple-800',
  },
  handling_human: {
    label: '人工处理中',
    className: 'border-violet-200 bg-violet-50 text-violet-800',
  },
}

export function StatusBadge({ status }: { status: RunStatus }) {
  const style = RUN_STATUS_STYLE[status] ?? RUN_STATUS_STYLE.created
  return (
    <span
      className={`inline-flex items-center rounded-badge border px-2 py-0.5 text-[11px] font-medium ${style.className}`}
    >
      {style.label}
    </span>
  )
}
