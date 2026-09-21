'use client'

/**
 * 评测看板 v2
 *
 * L1 脚本回归与 L2 用户模拟评测分列对比 每个数字标注来源与模型
 * L2 展示 Wilson 95% 置信区间与相邻报告改进显著性
 * 失败明细按判定四层分组 模拟器失败单独标注不计入被测模型成绩
 * 视觉遵循 docs/v2-ui-specs.md 面 1：blue 唯一主色 zinc 中性 徽章与区间条
 */

import { CaretRight, Gauge } from '@phosphor-icons/react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { AppShell } from '@/components/AppShell'
import { Skeleton } from '@/components/Skeleton'
import { api } from '@/lib/api'
import type { EvalCaseResultView, EvalReportSummary, FailureKind, SimTaskView } from '@/lib/types'

// ---------- 常量 ----------

const SAMPLE_OPTIONS = [
  { value: 'p0', label: 'P0 全量' },
  { value: 'p1', label: 'P1 抽样' },
  { value: 'p2', label: 'P2 抽样' },
  { value: 'all', label: '全部' },
] as const
type SampleValue = (typeof SAMPLE_OPTIONS)[number]['value']

const REPEAT_OPTIONS = [
  { value: 1, label: '1 轮' },
  { value: 3, label: '3 轮' },
] as const

/**
 * 各抽样档用例数 来自 SIM_CASES 统计 与 packages/eval/src/cases.js 同步
 * p1 为 P1 用例隔一取 p2 为 P2 用例隔五取 修改用例集需更新
 */
const CASE_COUNTS: Record<SampleValue, number> = { p0: 26, p1: 23, p2: 4, all: 88 }

/** 单条用例 token 估算均值 与 estimateSuiteTokens 一致 */
const TOKEN_PER_CASE = 3500

/** L2 默认模型 与 sim-suite.ts 的 DEFAULT_* 常量一致 */
const DEFAULT_MODELS = {
  agent: 'claude-sonnet-5',
  user: 'claude-haiku-4-5-20251001',
  judge: 'claude-sonnet-5',
}

const KIND_LABEL: Record<FailureKind, string> = {
  state: '终态',
  gateway: '网关',
  exception: '异常',
  trajectory: '轨迹',
  escalation: '升级',
  clarify: '补问',
  args: '参数',
  communicate: '沟通',
  judge: '判分',
  simulator: '模拟器',
}

/** 判定四层 与契约 FAILURE_KINDS 注释的映射一致 simulator 单独标注不计入成绩 */
const FAILURE_LAYERS: Array<{ id: string; title: string; desc: string; kinds: FailureKind[] }> = [
  {
    id: 'state',
    title: '状态层',
    desc: '数据库终态与网关副作用一致',
    kinds: ['state', 'gateway', 'exception'],
  },
  {
    id: 'trajectory',
    title: '轨迹层',
    desc: '工具调用序列 升级与补问行为正确',
    kinds: ['trajectory', 'escalation', 'clarify'],
  },
  { id: 'args', title: '参数层', desc: '工具入参精确', kinds: ['args'] },
  {
    id: 'quality',
    title: '回复质量层',
    desc: '措辞与政策表述 LLM judge 判定',
    kinds: ['communicate', 'judge'],
  },
]

const CATEGORY_LABEL: Record<string, string> = {
  happy_path: '主链路',
  clarification: '多轮补问',
  policy_boundary: '政策边界',
  approval: '人工审批',
  rejection: '拒绝冲突',
  fault_injection: '故障注入',
  security: '安全防御',
  recovery: '恢复幂等',
}

// ---------- 工具函数 ----------

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`
}

/** 任务成功率 优先取指标 旧报告无指标时用通过比例兜底 */
function tsrOf(report: EvalReportSummary): number {
  const metrics = report.report.metrics?.task_success_rate
  if (metrics !== undefined) return metrics
  return report.total > 0 ? report.passed / report.total : 0
}

/** Pass^k 的 k 值 从 passAtK 键名提取 无多轮数据返回 null */
function passK(report: EvalReportSummary): number | null {
  const keys = Object.keys(report.report.passAtK ?? {})
  if (keys.length === 0) return null
  const match = keys[0]!.match(/\d+/)
  return match ? Number(match[0]) : null
}

/** 旧版报告失败是字符串数组 运行时统一为结构化失败 归入状态层 */
function normalizeFailures(
  result: EvalCaseResultView,
): Array<{ kind: FailureKind; message: string }> {
  return (result.failures ?? []).map((failure) =>
    typeof failure === 'string' ? { kind: 'state' as const, message: failure } : failure,
  )
}

/** 某判定层的失败条目与命中用例数 */
function layerItems(
  results: EvalCaseResultView[],
  kinds: FailureKind[],
): { failedCases: number; items: Array<{ caseId: string; kind: FailureKind; message: string }> } {
  const items: Array<{ caseId: string; kind: FailureKind; message: string }> = []
  let failedCases = 0
  for (const result of results) {
    const matched = normalizeFailures(result).filter((failure) =>
      kinds.includes(failure.kind),
    )
    if (matched.length > 0) {
      failedCases += 1
      items.push(...matched.map((failure) => ({ caseId: result.caseId, ...failure })))
    }
  }
  return { failedCases, items }
}

// ---------- 小组件 ----------

const BADGE_TONES = {
  l1: 'border-zinc-200 bg-zinc-50 text-zinc-600',
  l2: 'border-blue-200 bg-blue-50 text-blue-800',
  pass: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  fail: 'border-red-200 bg-red-50 text-red-800',
  neutral: 'border-zinc-200 bg-zinc-50 text-zinc-600',
  warn: 'border-amber-200 bg-amber-50 text-amber-800',
} as const

function Badge({
  tone,
  children,
}: {
  tone: keyof typeof BADGE_TONES
  children: ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center rounded-badge border px-1.5 py-0.5 text-[10px] font-medium ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  )
}

/**
 * Wilson 区间条 端点圆点为点估计 下方 0% 50% 100% 轴
 * primary 当前报告蓝条 secondary 对比报告灰条
 */
function CiBar({
  lower,
  upper,
  point,
  variant,
}: {
  lower: number
  upper: number
  point: number
  variant: 'primary' | 'secondary'
}) {
  const clamp = (value: number) => Math.min(100, Math.max(0, value * 100))
  const barClass =
    variant === 'primary' ? 'h-2 bg-blue-300' : 'h-3.5 bg-zinc-300'
  const dotClass = variant === 'primary' ? 'bg-blue-700' : 'bg-zinc-500'
  return (
    <div className="w-full max-w-64">
      <div
        className={`relative w-full rounded-full bg-zinc-100 ${variant === 'primary' ? 'h-2' : 'h-3.5'}`}
      >
        <div
          className={`absolute inset-y-0 rounded-full ${barClass}`}
          style={{ left: `${clamp(lower)}%`, width: `${clamp(upper) - clamp(lower)}%` }}
        />
        <span
          className={`absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${dotClass}`}
          style={{ left: `${clamp(point)}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-stone-400">
        <span>0%</span>
        <span>50%</span>
        <span>100%</span>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  valueClass = 'text-stone-900',
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <div>
      <div className="text-xs text-stone-500">{label}</div>
      <div className={`mt-1 text-4xl font-semibold tabular-nums tracking-tight ${valueClass}`}>
        {value}
      </div>
    </div>
  )
}

function Segment<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="inline-flex rounded-control border border-zinc-200 bg-white p-0.5">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          onClick={() => onChange(option.value)}
          className={`rounded-[6px] px-2.5 py-1 text-xs font-medium transition-colors duration-200 ${
            option.value === value
              ? 'bg-blue-100 text-blue-800'
              : 'text-stone-500 hover:text-stone-700'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

// ---------- 报告对比 ----------

/** 单列报告卡 L1 无置信区间 L2 画 Wilson 区间条 */
function ReportColumn({
  report,
  level,
}: {
  report: EvalReportSummary
  level: 'L1' | 'L2'
}) {
  const tsr = tsrOf(report)
  const k = passK(report)
  const passPower = report.report.passPowerK
  const passAt = k !== null ? report.report.passAtK?.[`pass@${k}`] : undefined
  const ci = report.report.confidenceIntervals?.['task_success_rate']

  return (
    <div className="min-w-0 flex-1 rounded-container border border-hairline bg-white px-5 py-4">
      <div className="flex items-center justify-between gap-2">
        <Badge tone={level === 'L1' ? 'l1' : 'l2'}>
          {level === 'L1' ? 'L1 脚本回归' : 'L2 用户模拟'}
        </Badge>
        <span className="truncate font-mono text-xs text-stone-400">{report.reportId}</span>
      </div>

      <div className="mt-4">
        <Stat
          label="任务成功率 TSR"
          value={percent(tsr)}
          valueClass={report.failed > 0 ? 'text-stone-900' : 'text-emerald-700'}
        />
      </div>

      {level === 'L2' && ci ? (
        <div className="mt-3">
          <CiBar lower={ci.lower} upper={ci.upper} point={tsr} variant="primary" />
          <div className="mt-1 text-xs text-stone-500">
            Wilson 95% 区间 [{percent(ci.lower)}, {percent(ci.upper)}] 样本 {report.total} 条
          </div>
        </div>
      ) : level === 'L1' ? (
        <div className="mt-3 text-xs text-stone-500">确定性回放，无采样方差，不计算置信区间。</div>
      ) : (
        <div className="mt-3 text-xs text-stone-500">
          该报告生成于置信区间功能上线前，无区间数据。
        </div>
      )}

      {passPower !== undefined && k !== null && (
        <div className="mt-3 border-t border-hairline pt-3">
          <div className="text-xs text-stone-500">
            Pass^{k} 稳定性
            <span className="ml-2 text-base font-semibold tabular-nums text-stone-900">
              {percent(passPower)}
            </span>
          </div>
          <div className="mt-1 text-xs text-stone-500">
            Pass@{k} 能力上限
            <span className="ml-2 text-base font-semibold tabular-nums text-stone-900">
              {passAt !== undefined ? percent(passAt) : '-'}
            </span>
          </div>
        </div>
      )}

      <div className="mt-3 border-t border-hairline pt-3 text-xs text-stone-600">
        <div className="tabular-nums">
          通过 {report.passed}/{report.total}
        </div>
        <div className="mt-1 truncate font-mono text-stone-500">{report.model}</div>
        {level === 'L2' && (
          <div className="mt-0.5 truncate font-mono text-stone-400">
            模拟器 {report.userModel ?? '-'} · judge {report.judgeModel ?? '-'}
          </div>
        )}
        <div className="mt-1 tabular-nums text-stone-400">
          {new Date(report.startedAt).toLocaleString('zh-CN')}
        </div>
      </div>
    </div>
  )
}

function EmptyColumn({ level }: { level: 'L1' | 'L2' }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-container border border-dashed border-stone-300 px-5 py-10 text-sm text-stone-400">
      <span className="text-xs">{level === 'L1' ? '暂无 L1 报告' : '暂无 L2 报告'}</span>
      <span className="text-xs">运行对应评测后在此展示</span>
    </div>
  )
}

/** 相邻两份 L2 报告的任务成功率区间对比 重叠即改进不显著 */
function ImprovementStrip({
  previous,
  latest,
}: {
  previous: EvalReportSummary
  latest: EvalReportSummary
}) {
  const prevCi = previous.report.confidenceIntervals?.['task_success_rate']
  const latestCi = latest.report.confidenceIntervals?.['task_success_rate']

  if (!prevCi || !latestCi) {
    return (
      <div className="rounded-container border border-hairline bg-white px-4 py-3 text-xs text-stone-500">
        最近两份 L2 报告缺少置信区间，无法判断改进显著性。
      </div>
    )
  }

  const overlap = latestCi.lower <= prevCi.upper && prevCi.lower <= latestCi.upper
  const verdict = overlap
    ? { tone: 'neutral' as const, text: '区间重叠，改进不显著' }
    : latestCi.lower > prevCi.upper
      ? { tone: 'pass' as const, text: '最新区间整体高于上份，改进显著' }
      : { tone: 'fail' as const, text: '最新区间整体低于上份，明显下降' }

  return (
    <div className="rounded-container border border-hairline bg-white px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <span className="shrink-0 text-xs font-medium text-stone-600">改进显著性</span>
        <Badge tone={verdict.tone}>{verdict.text}</Badge>
      </div>
      <div className="mt-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-[10px] tabular-nums text-stone-400">最新</span>
          <CiBar
            lower={latestCi.lower}
            upper={latestCi.upper}
            point={tsrOf(latest)}
            variant="primary"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-[10px] tabular-nums text-stone-400">上份</span>
          <CiBar
            lower={prevCi.lower}
            upper={prevCi.upper}
            point={tsrOf(previous)}
            variant="secondary"
          />
        </div>
      </div>
    </div>
  )
}

// ---------- 分层指标 ----------

function LayerMetrics({ results }: { results: EvalCaseResultView[] }) {
  const total = results.length
  return (
    <div className="rounded-container border border-hairline bg-white">
      {FAILURE_LAYERS.map((layer, index) => {
        const { failedCases } = layerItems(results, layer.kinds)
        const rate = total > 0 ? 1 - failedCases / total : 0
        return (
          <div
            key={layer.id}
            className={`flex items-center justify-between gap-4 px-4 py-3 ${
              index > 0 ? 'border-t border-hairline' : ''
            }`}
          >
            <div className="min-w-0">
              <div className="text-sm font-medium text-stone-800">{layer.title}</div>
              <div className="mt-0.5 text-xs text-stone-500">{layer.desc}</div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-2xl font-semibold tabular-nums tracking-tight text-stone-900">
                {percent(rate)}
              </div>
              <div className="text-[10px] tabular-nums text-stone-400">
                {failedCases > 0 ? `${failedCases} 条用例有失败` : '全部通过'}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------- 失败明细 ----------

function FailureRow({
  result,
  expanded,
  onToggle,
}: {
  result: EvalCaseResultView
  expanded: boolean
  onToggle: () => void
}) {
  const failures = normalizeFailures(result)
  const hasSimulator = failures.some((failure) => failure.kind === 'simulator')

  return (
    <>
      <tr
        className="cursor-pointer transition-colors duration-200 hover:bg-stone-50"
        onClick={onToggle}
      >
        <td className="px-3 py-2 font-mono text-xs text-stone-700">
          <span
            className={`mr-1.5 inline-block text-stone-400 transition-transform duration-200 ${
              expanded ? 'rotate-90' : ''
            }`}
          >
            <CaretRight size={10} weight="bold" />
          </span>
          {result.caseId}
        </td>
        <td className="px-3 py-2 text-xs text-stone-600">{result.priority}</td>
        <td className="px-3 py-2 tabular-nums text-stone-700">{result.turns ?? '-'}</td>
        <td className="px-3 py-2">
          <Badge tone="fail">失败 {failures.length} 项</Badge>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-stone-50/60">
          <td colSpan={4} className="px-3 pb-4 pt-1">
            <div className="space-y-3 rounded-control border border-hairline bg-white px-4 py-3">
              {FAILURE_LAYERS.map((layer) => {
                // judge 失败单独渲染判据与理由 避免与 fail-item 重复
                const kinds = layer.kinds.filter((kind) => kind !== 'judge')
                const { items } = layerItems([result], kinds)
                if (items.length === 0) return null
                return (
                  <div key={layer.id}>
                    <div className="text-xs font-medium text-stone-700">
                      {layer.title}
                      <span className="ml-2 font-normal text-stone-400">{layer.desc}</span>
                    </div>
                    <div className="mt-1.5 space-y-1.5">
                      {items.map((failure, index) => (
                        <div key={`${failure.kind}-${index}`} className="flex gap-2">
                          <span className="shrink-0">
                            <Badge tone="neutral">{KIND_LABEL[failure.kind]}</Badge>
                          </span>
                          <span className="min-w-0 text-xs leading-relaxed text-stone-600">
                            {failure.message}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}

              {result.judge && result.judge.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-stone-700">
                    LLM 判分
                    <span className="ml-2 font-normal text-stone-400">判据与理由</span>
                  </div>
                  <div className="mt-1.5 space-y-1.5">
                    {result.judge.map((item, index) => (
                      <div key={index} className="flex gap-2">
                        <span className="shrink-0">
                          <Badge tone="neutral">判分</Badge>
                        </span>
                        <div className="min-w-0 text-xs leading-relaxed text-stone-600">
                          <div>
                            <span className="text-stone-400">判据</span> {item.rubric}
                          </div>
                          <div className="mt-0.5">
                            <span className="text-stone-400">理由</span> {item.reason}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {hasSimulator && (
                <div className="text-xs text-amber-800">
                  含模拟器失败 模拟器自身不稳定不计入被测模型成绩 可重跑排除
                </div>
              )}

              <div className="border-t border-hairline pt-2 text-xs text-stone-400">
                <div>
                  失败导出
                  <span className="ml-2 font-mono">eval/failures/{result.caseId}_*.json</span>
                  <span className="ml-2">含场景与完整对话 transcript</span>
                </div>
                {result.runId && (
                  <a
                    href={`/runs/${result.runId}`}
                    className="mt-1 inline-block text-blue-600 hover:text-blue-700"
                  >
                    运行回放 时间线与事件流 →
                  </a>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ---------- L2 进度 ----------

function SimProgressCard({ task }: { task: SimTaskView }) {
  const progress = task.progress
  return (
    <div className="flex items-center gap-3 rounded-control border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm text-sky-900">
      <span className="size-2 shrink-0 animate-breathe rounded-full bg-sky-500" aria-hidden="true" />
      {progress ? (
        <>
          <span className="tabular-nums">
            L2 第 {progress.round}/{progress.repeat} 轮 · 用例 {progress.caseIndex}/
            {progress.totalCases} · 当前
            <span className="ml-1 font-mono">{progress.caseId}</span> · 已用{' '}
            {formatElapsed(progress.elapsedMs)}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-sky-700">
            通过 {progress.passed} · 失败 {progress.failed}
          </span>
        </>
      ) : (
        <span>L2 评测任务已启动 准备用例中</span>
      )}
    </div>
  )
}

// ---------- 页面 ----------

export default function EvalPage() {
  const [reports, setReports] = useState<EvalReportSummary[]>([])
  const [health, setHealth] = useState<{ modelAvailable: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [runningL1, setRunningL1] = useState(false)
  const [startingL2, setStartingL2] = useState(false)

  // L2 启动表单
  const [sample, setSample] = useState<SampleValue>('p0')
  const [repeat, setRepeat] = useState(1)
  const [agentModel, setAgentModel] = useState('')
  const [userModel, setUserModel] = useState('')
  const [judgeModel, setJudgeModel] = useState('')

  // L2 后台任务轮询
  const [simTaskId, setSimTaskId] = useState<string | null>(null)
  const [task, setTask] = useState<SimTaskView | null>(null)

  const [expandedCaseId, setExpandedCaseId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [reportBody, healthBody] = await Promise.all([api.listEvalReports(), api.health()])
      setReports(reportBody.reports)
      setHealth(healthBody)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 轮询 L2 任务 每 2 秒一次 完成刷新报告列表
  useEffect(() => {
    if (!simTaskId) return
    let cancelled = false
    const poll = async () => {
      try {
        const body = await api.getSimTask(simTaskId)
        if (cancelled) return
        setTask(body.task)
        if (body.task.status === 'done') {
          setSimTaskId(null)
          setTask(null)
          await load()
        }
      } catch (caught) {
        if (cancelled) return
        setSimTaskId(null)
        setTask(null)
        setError(caught instanceof Error ? caught.message : 'L2 任务状态获取失败')
      }
    }
    void poll()
    const timer = setInterval(poll, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [simTaskId, load])

  const triggerL1 = async () => {
    if (runningL1) return
    setRunningL1(true)
    try {
      await api.runEval()
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'L1 评测失败')
    } finally {
      setRunningL1(false)
    }
  }

  const startL2 = async () => {
    if (startingL2 || simTaskId) return
    setStartingL2(true)
    setError(null)
    try {
      // 空模型名省略字段 由后端回退到环境默认 不传空串
      const trimmedAgent = agentModel.trim()
      const trimmedUser = userModel.trim()
      const trimmedJudge = judgeModel.trim()
      const body = await api.startSimEval({
        sample,
        repeat,
        ...(trimmedAgent ? { agentModel: trimmedAgent } : {}),
        ...(trimmedUser ? { userModel: trimmedUser } : {}),
        ...(trimmedJudge ? { judgeModel: trimmedJudge } : {}),
      })
      setTask({
        status: 'running',
        progress: null,
        reportId: null,
        error: null,
        startedAt: body.startedAt,
      })
      setSimTaskId(body.taskId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'L2 评测启动失败')
    } finally {
      setStartingL2(false)
    }
  }

  const latestL1 = reports.find((report) => (report.level ?? 'L1') === 'L1')
  const latestL2 = reports.find((report) => report.level === 'L2')
  const l2Reports = reports.filter((report) => report.level === 'L2')
  const previousL2 = l2Reports[1]

  // 明细数据 L2 优先 无 L2 报告时用最新 L1
  const detailReport = latestL2 ?? latestL1
  const detailCases = detailReport?.report.caseResults ?? []
  const detailIsL2 = detailReport?.level === 'L2'

  const failedCases = detailCases.filter((result) => !result.passed)
  const avgTurns =
    detailCases.length > 0
      ? detailCases.reduce((sum, c) => sum + (c.turns ?? 0), 0) / detailCases.length
      : 0
  const agentTokens = detailCases.reduce(
    (sum, c) => sum + (c.agentInputTokens ?? 0) + (c.agentOutputTokens ?? 0),
    0,
  )
  const simulatorTokens = detailCases.reduce(
    (sum, c) => sum + (c.simulatorInputTokens ?? 0) + (c.simulatorOutputTokens ?? 0),
    0,
  )
  const costTotal = detailCases.reduce(
    (sum, c) => sum + (c.agentCostUsd ?? 0) + (c.simulatorCostUsd ?? 0),
    0,
  )
  const hasCost = detailCases.some(
    (c) => c.agentCostUsd !== undefined || c.simulatorCostUsd !== undefined,
  )

  const estimatedCases = CASE_COUNTS[sample]
  const estimatedTokens = estimatedCases * repeat * TOKEN_PER_CASE
  const l2Unavailable = health !== null && !health.modelAvailable

  return (
    <AppShell>
      <div className="page-enter mx-auto max-w-5xl px-6 py-8">
        {/* 页头 */}
        <div className="flex items-center justify-between gap-6">
          <h1 className="shrink-0 text-xl font-semibold tracking-tight">评测看板</h1>
          <p className="min-w-0 text-sm text-stone-500">
            脚本 L1 与真实模型 L2 的成绩分开展示，每个数字标注来源与模型。
          </p>
        </div>

        {/* 运行评测 */}
        <section className="mt-8 rounded-container border border-hairline bg-white px-5 py-4">
          <h2 className="text-sm font-medium text-stone-700">运行评测</h2>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 text-sm text-stone-600">
              <span className="font-medium text-stone-800">L1 脚本回归</span>
              <span className="ml-2 text-stone-500">
                ScriptedModel 回放理想轨迹，全量 88 条约 2 秒完成
              </span>
            </div>
            <button
              type="button"
              onClick={triggerL1}
              disabled={runningL1}
              className="shrink-0 rounded-control border border-zinc-200 bg-white px-4 py-2 text-xs font-medium text-stone-700 transition-colors duration-200 hover:bg-blue-50 active:scale-[0.98] disabled:opacity-50"
            >
              {runningL1 ? '评测执行中' : '运行 L1 脚本回归'}
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-hairline pt-4">
            <Segment options={SAMPLE_OPTIONS} value={sample} onChange={setSample} />
            <Segment options={REPEAT_OPTIONS} value={repeat} onChange={setRepeat} />
            {(['agent', 'user', 'judge'] as const).map((key) => (
              <input
                key={key}
                type="text"
                value={key === 'agent' ? agentModel : key === 'user' ? userModel : judgeModel}
                onChange={(event) => {
                  const value = event.target.value
                  if (key === 'agent') setAgentModel(value)
                  else if (key === 'user') setUserModel(value)
                  else setJudgeModel(value)
                }}
                placeholder={DEFAULT_MODELS[key]}
                aria-label={key === 'agent' ? '被测模型' : key === 'user' ? '用户模拟器模型' : 'Judge 模型'}
                className="w-48 rounded-control border border-zinc-200 bg-white px-3 py-1.5 font-mono text-xs text-stone-700 placeholder:text-stone-400 focus:border-blue-300 focus:outline-none"
              />
            ))}
            <div className="flex min-w-0 flex-1 items-center justify-end gap-4">
              <span className="text-xs tabular-nums text-stone-500">
                {SAMPLE_OPTIONS.find((option) => option.value === sample)!.label} {repeat} 轮约{' '}
                {estimatedCases} 条用例，估算约 {(estimatedTokens / 10000).toFixed(1)} 万 token
              </span>
              <button
                type="button"
                onClick={startL2}
                disabled={startingL2 || simTaskId !== null || l2Unavailable}
                className="shrink-0 rounded-control bg-blue-600 px-4 py-2 text-xs font-medium text-white transition-colors duration-200 hover:bg-blue-700 active:scale-[0.98] disabled:opacity-50"
              >
                {startingL2 || simTaskId ? 'L2 评测运行中' : '启动 L2 用户模拟'}
              </button>
            </div>
          </div>

          {l2Unavailable && (
            <div className="mt-3 rounded-control border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              未配置 ANTHROPIC_API_KEY，L2 用户模拟评测不可用，L1 脚本回归不受影响。诚实原则：不输出模拟成绩。
            </div>
          )}

          {task && task.status === 'running' && (
            <div className="mt-3">
              <SimProgressCard task={task} />
            </div>
          )}
        </section>

        {error && (
          <p className="mt-4 rounded-control border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        {loading && (
          <>
            <div className="mt-8 grid gap-4 md:grid-cols-2">
              {[0, 1].map((index) => (
                <div key={index} className="rounded-container border border-hairline bg-white px-5 py-4">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="mt-3 h-9 w-40" />
                  <Skeleton className="mt-3 h-2 w-56" />
                  <Skeleton className="mt-4 h-3 w-full" />
                </div>
              ))}
            </div>
            <div className="mt-8 space-y-2.5">
              {[0, 1, 2, 3, 4].map((index) => (
                <Skeleton key={index} className="h-5 w-full max-w-md" />
              ))}
            </div>
          </>
        )}

        {!loading && reports.length === 0 && (
          <div className="mt-6 flex flex-col items-center gap-2 rounded-container border border-dashed border-stone-300 px-6 py-12 text-sm text-stone-500">
            <Gauge size={28} className="text-stone-300" aria-hidden="true" />
            <span>暂无评测报告 先运行 L1 脚本回归或启动 L2 用户模拟</span>
          </div>
        )}

        {!loading && reports.length > 0 && (
          <>
            {/* 报告对比 */}
            <section className="mt-8">
              <h2 className="mb-2 text-sm font-medium text-stone-700">最近报告对比</h2>
              <div className="flex flex-col gap-4 md:flex-row md:items-stretch">
                {latestL1 ? <ReportColumn report={latestL1} level="L1" /> : <EmptyColumn level="L1" />}
                {latestL2 ? <ReportColumn report={latestL2} level="L2" /> : <EmptyColumn level="L2" />}
              </div>
            </section>

            {latestL2 && previousL2 && (
              <div className="mt-4">
                <ImprovementStrip previous={previousL2} latest={latestL2} />
              </div>
            )}

            <p className="mt-4 text-xs text-stone-400">
              诚实声明：所有数字来自实际运行结果。L1 为 88 条脚本回放，L2 为抽样用户模拟评测；
              Wilson 95% 置信区间仅 L2 计算，未配置密钥时不输出模拟成绩。
            </p>

            {detailCases.length > 0 && (
              <>
                {/* 分层指标 */}
                <section className="mt-8">
                  <h2 className="mb-2 text-sm font-medium text-stone-700">分层指标</h2>
                  <LayerMetrics results={detailCases} />
                </section>

                {/* 分类结果 */}
                {detailReport?.report.byCategory && (
                  <section className="mt-8">
                    <h2 className="mb-2 text-sm font-medium text-stone-700">分类结果</h2>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {Object.entries(detailReport.report.byCategory).map(([category, entry]) => {
                        const allPassed = entry.passed === entry.total
                        return (
                          <div
                            key={category}
                            className={`rounded-container border px-4 py-3 ${
                              allPassed
                                ? 'border-emerald-200 bg-emerald-50'
                                : 'border-orange-200 bg-orange-50'
                            }`}
                          >
                            <div
                              className={`text-xs ${allPassed ? 'text-emerald-700' : 'text-orange-700'}`}
                            >
                              {CATEGORY_LABEL[category] ?? category}
                            </div>
                            <div
                              className={`mt-1 text-2xl font-semibold tabular-nums tracking-tight ${
                                allPassed ? 'text-emerald-800' : 'text-orange-800'
                              }`}
                            >
                              {entry.passed}
                              <span
                                className={`text-base font-normal ${
                                  allPassed ? 'text-emerald-700' : 'text-orange-700'
                                }`}
                              >
                                /{entry.total}
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </section>
                )}

                {/* 失败明细 */}
                <section className="mt-8">
                  <h2 className="mb-2 text-sm font-medium text-stone-700">失败明细</h2>
                  {failedCases.length === 0 ? (
                    <div className="rounded-container border border-hairline bg-white px-4 py-6 text-center text-sm text-stone-400">
                      本报告无失败用例
                    </div>
                  ) : (
                    <div className="overflow-x-auto rounded-container border border-hairline bg-white">
                      <table className="w-full text-sm">
                        <thead className="text-left text-xs text-stone-500">
                          <tr className="border-b border-hairline">
                            <th className="px-3 py-2 font-medium">用例</th>
                            <th className="px-3 py-2 font-medium">优先级</th>
                            <th className="px-3 py-2 font-medium">轮次</th>
                            <th className="px-3 py-2 font-medium">结果</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-hairline">
                          {failedCases.map((result) => (
                            <FailureRow
                              key={result.caseId}
                              result={result}
                              expanded={expandedCaseId === result.caseId}
                              onToggle={() =>
                                setExpandedCaseId(
                                  expandedCaseId === result.caseId ? null : result.caseId,
                                )
                              }
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                {/* 模拟对话开销 */}
                {detailIsL2 && (
                  <section className="mt-8">
                    <h2 className="mb-2 text-sm font-medium text-stone-700">模拟对话开销</h2>
                    <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
                      <div>
                        <div className="text-xs text-stone-500">平均对话轮次</div>
                        <div className="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight text-stone-900">
                          {avgTurns.toFixed(1)}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-stone-500">Agent token</div>
                        <div className="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight text-stone-900">
                          {agentTokens.toLocaleString()}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-stone-500">模拟器 token</div>
                        <div className="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight text-stone-900">
                          {simulatorTokens.toLocaleString()}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-stone-500">成本合计</div>
                        <div className="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight text-stone-900">
                          {hasCost ? `$${costTotal.toFixed(4)}` : '未统计'}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-stone-500">用户模拟器模型</div>
                        <div className="mt-0.5 truncate font-mono text-sm text-stone-700">
                          {detailReport?.userModel ?? '-'}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-stone-500">Judge 模型</div>
                        <div className="mt-0.5 truncate font-mono text-sm text-stone-700">
                          {detailReport?.judgeModel ?? '-'}
                        </div>
                      </div>
                    </div>
                  </section>
                )}
              </>
            )}

            {/* 历史报告 */}
            <section className="mt-8">
              <h2 className="mb-2 text-sm font-medium text-stone-700">历史报告</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-stone-500">
                    <tr className="border-b border-hairline">
                      <th className="px-4 py-2.5 font-medium">报告</th>
                      <th className="px-4 py-2.5 font-medium">来源</th>
                      <th className="px-4 py-2.5 font-medium">模型</th>
                      <th className="px-4 py-2.5 font-medium">通过率</th>
                      <th className="px-4 py-2.5 font-medium">Pass^k</th>
                      <th className="px-4 py-2.5 font-medium">门禁</th>
                      <th className="px-4 py-2.5 font-medium">时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {reports.map((report) => {
                      const k = passK(report)
                      const passPower = report.report.passPowerK
                      return (
                        <tr
                          key={report.reportId}
                          className="transition-colors duration-200 hover:bg-stone-100"
                        >
                          <td className="px-4 py-2.5 font-mono text-xs text-stone-600">
                            {report.reportId}
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge tone={report.level === 'L2' ? 'l2' : 'l1'}>
                              {report.level === 'L2' ? 'L2 模拟' : 'L1 脚本'}
                            </Badge>
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs text-stone-600">
                            {report.model}
                          </td>
                          <td className="px-4 py-2.5 tabular-nums text-stone-700">
                            {report.passed}/{report.total}
                          </td>
                          <td className="px-4 py-2.5 tabular-nums text-stone-700">
                            {passPower !== undefined && k !== null
                              ? `Pass^${k} ${percent(passPower)}`
                              : '-'}
                          </td>
                          <td className="px-4 py-2.5">
                            <span
                              className={`inline-flex items-center rounded-badge border px-2 py-0.5 text-[11px] font-medium ${
                                report.gatePassed
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                                  : 'border-red-200 bg-red-50 text-red-800'
                              }`}
                            >
                              {report.gatePassed ? '通过' : '未通过'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-xs tabular-nums text-stone-500">
                            {new Date(report.startedAt).toLocaleString('zh-CN')}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </AppShell>
  )
}
