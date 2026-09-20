/**
 * 状态徽章
 *
 * 运行状态与审批状态的统一视觉映射
 */

import type { RunStatus } from '@/lib/types'

const RUN_STATUS_STYLE: Record<RunStatus, { label: string; className: string }> = {
  created: { label: '已创建', className: 'bg-slate-700 text-slate-200' },
  running: { label: '执行中', className: 'bg-sky-600 text-white' },
  awaiting_input: { label: '等待补充信息', className: 'bg-amber-600 text-white' },
  awaiting_approval: { label: '等待审批', className: 'bg-orange-600 text-white' },
  completed: { label: '已完成', className: 'bg-emerald-600 text-white' },
  failed: { label: '失败', className: 'bg-red-600 text-white' },
  cancelled: { label: '已取消', className: 'bg-slate-600 text-slate-200' },
  escalated: { label: '已升级人工', className: 'bg-purple-600 text-white' },
}

export function StatusBadge({ status }: { status: RunStatus }) {
  const style = RUN_STATUS_STYLE[status] ?? RUN_STATUS_STYLE.created
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style.className}`}
    >
      {style.label}
    </span>
  )
}
