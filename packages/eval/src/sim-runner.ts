/**
 * L2 用户模拟评测运行器
 *
 * LLM 用户模拟器与被测真实模型多轮对话 审批按用例配置自动驱动
 * 判定三层 终态断言与轨迹为代码判定 communicateInfo 子串匹配为代码判定
 * judgeRubric 走 LLM judge 且只覆盖主观项 不决定任务成功
 */

import type { ChatModel } from '@aftersales/agent'
import { PROMPT_VERSION } from '@aftersales/agent'
import type { EvalCase } from '@aftersales/contracts'
import { FrozenClock, KeywordPolicyScorer } from '@aftersales/domain'
import type { Actor } from '@aftersales/domain'
import { FaultController } from '@aftersales/tools'
import { mkdirSync, writeFileSync } from 'node:fs'
import { BASELINE_FROZEN_TIME, composeSystem, type ComposedSystem } from '@aftersales/runtime'
import { UserSimulator, TallyingModel } from './simulator.js'
import { judgeTranscript, type TranscriptTurn } from './judge.js'
import type { CaseDetail, JudgeFailure } from './types.js'
import type { AssertionFailure } from './validators.js'
import { collectAssertions, driveApproval, driveHandoverStep, driveTurn } from './runner.js'

/** 模拟评测超时与脚本回归一致 加速故障注入用例 */
const SIM_TIMEOUT_MS = 300

export interface RunSimOptions {
  /** 被测 Agent 真实模型 */
  agentModel: ChatModel
  /** 用户模拟器模型 与被测模型强制分离 缺省拒绝执行 */
  userModel: ChatModel
  /** judge 模型 与被测模型分离 缺省不评主观项 */
  judgeModel?: ChatModel
  /** 失败用例导出目录 缺省不导出 */
  failureDir?: string
}

/** 读取一次模拟对话中的全部助手文本 顺序保持 */
function readAgentMessages(system: ComposedSystem, runId: string): string[] {
  const rows = system.queryTable('agent_events', { run_id: runId })
  return rows
    .filter((row) => row.type === 'message.completed')
    .sort((a, b) => Number(a.sequence) - Number(b.sequence))
    .map((row) => String((row.payload_json as string | undefined) ?? ''))
    .map((payload) => {
      try {
        return String((JSON.parse(payload) as { text?: string }).text ?? '')
      } catch {
        return ''
      }
    })
    .filter((text) => text.length > 0)
}

/** 读取最新一条助手文本 供模拟器作出反应 */
function readLastAgentMessage(system: ComposedSystem, runId: string): string {
  const messages = readAgentMessages(system, runId)
  return messages[messages.length - 1] ?? ''
}

/** 收集完整 transcript 供 judge 判定 */
function readTranscript(system: ComposedSystem, runId: string): TranscriptTurn[] {
  const rows = system.queryTable('agent_events', { run_id: runId })
  const ordered = [...rows].sort((a, b) => Number(a.sequence) - Number(b.sequence))
  const turns: TranscriptTurn[] = []
  for (const row of ordered) {
    const payload = safeParse(row.payload_json)
    if (row.type === 'message.user' && payload?.text) {
      turns.push({ role: 'user', text: String(payload.text) })
    } else if (row.type === 'message.completed' && payload?.text) {
      turns.push({ role: 'agent', text: String(payload.text) })
    }
  }
  return turns
}

function safeParse(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 失败用例存根 人工归因后可提升为正式回归用例 */
function exportFailureStub(
  dir: string,
  simCase: EvalCase,
  runId: string,
  transcript: TranscriptTurn[],
  failures: AssertionFailure[],
): void {
  const stub = {
    caseId: simCase.id,
    runId,
    exportedAt: new Date().toISOString(),
    scenario: simCase.scenario,
    promptVersion: PROMPT_VERSION,
    transcript,
    failures: failures.map((failure) => ({ kind: failure.kind, message: failure.message })),
    promotionHint: '人工确认失败根因后 可将 scenario 与断言整理为正式回归用例 固化到 cases 目录',
  }
  const file = `${dir}/${simCase.id}-${Date.now()}.json`
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(stub, null, 2), 'utf-8')
  } catch {
    // 导出失败不影响评测结果
  }
}

/** 单条 L2 用例执行 */
export async function runSimCase(simCase: EvalCase, options: RunSimOptions): Promise<CaseDetail> {
  const startedAt = Date.now()
  const clock = new FrozenClock(simCase.frozenTime ?? BASELINE_FROZEN_TIME)
  const scenario = simCase.scenario
  if (!scenario) {
    throw new Error(`用例 ${simCase.id} 缺少 scenario 无法执行用户模拟`)
  }

  const tally = new TallyingModel(options.agentModel)
  const simulator = new UserSimulator({ model: options.userModel, scenario })
  const system = composeSystem({
    clock,
    model: tally,
    timeoutOverrideMs: SIM_TIMEOUT_MS,
    maxSteps: simCase.maxSteps,
    // 评测用确定性关键词打分器 与 L1 同构 检索结果不依赖 LLM
    policyScorer: new KeywordPolicyScorer(),
    fixturePatch: simCase.fixturePatch as never,
  })
  const actor: Actor = { role: simCase.actor.role, customerId: simCase.actor.customerId }
  const faults = new FaultController((simCase.faultPlan ?? []) as never)

  const failures: AssertionFailure[] = []
  let turns = 0
  let simInputTokens = 0
  let simOutputTokens = 0
  let runId = ''
  let judgeFailures: JudgeFailure[] | undefined
  let transcript: TranscriptTurn[] = []

  try {
    const run = await system.runService.start({
      customerId: simCase.actor.customerId ?? 'C1001',
      promptVersion: PROMPT_VERSION,
      model: tally.info.model,
      faultPlan: simCase.faultPlan ?? [],
      // L2 模拟会话标注 sim 来源 运营分析口径将其排除
      source: 'sim',
    })
    runId = run.runId
    const toolContext = { actor, runId, faults }

    // 开场白由模拟器生成
    const opening = await simulator.openingMessage()
    simInputTokens += opening.inputTokens
    simOutputTokens += opening.outputTokens
    let outcome = await driveTurn(system, runId, opening.text, toolContext, true)
    turns += 1

    // 对话推进 轮次上限内 模拟器与 Agent 交替
    const maxTurns = scenario.maxTurns
    while (turns < maxTurns) {
      // 剧本回合间物流事件注入 与运营端点共用同一注入入口
      if (outcome === 'awaiting_input') {
        for (const event of (simCase.logisticsEvents ?? []).filter(
          (item) => item.at === 'after_turn' && item.turnIndex === turns,
        )) {
          try {
            const injected = await system.logisticsService.inject(
              { role: 'operator' },
              {
                orderNo: event.orderNo,
                status: event.status,
                description: event.description,
                eventId: event.eventId ?? `sim_${runId}_${event.orderNo}_${event.status}`,
                source: 'simulator',
                runId,
              },
            )
            const result = await system.runner.processLogisticsEvent(runId, injected, toolContext)
            if (result.outcome) outcome = result.outcome
          } catch {
            // 领域拒绝注入 断言层按事件与运单状态判定
          }
        }
      }
      if (outcome === 'awaiting_input') {
        const question = readLastAgentMessage(system, runId)
        const reply = await simulator.replyTo(question)
        simInputTokens += reply.inputTokens
        simOutputTokens += reply.outputTokens
        if (reply.terminal) {
          if (reply.kind === 'transfer' && reply.text) {
            // 转人工诉求送达 Agent 给它按规则响应升级的机会 终态交给断言判定
            outcome = await driveTurn(system, runId, reply.text, toolContext, false)
            turns += 1
          }
          break
        }
        outcome = await driveTurn(system, runId, reply.text, toolContext, false)
        turns += 1
        continue
      }
      if (outcome === 'awaiting_approval' && simCase.approvalAction) {
        outcome = await driveApproval(system, runId, clock, simCase.approvalAction, toolContext)
        continue
      }
      break
    }

    if (turns >= maxTurns && outcome !== 'completed' && outcome !== 'escalated') {
      failures.push({
        kind: 'simulator',
        message: `对话超过 ${maxTurns} 轮未收敛 终态 ${outcome}`,
      })
    }

    // 升级人工后的接管剧本 L2 无真人坐席 按脚本执行接管对话与解决
    // 与 L1 runner 共用同一领域入口 领域拒绝吞掉 由断言判定
    for (const step of simCase.handoverScript ?? []) {
      await driveHandoverStep(system, runId, step, actor)
    }

    // 运行结束后的运营闭环动作
    for (const action of simCase.operatorActions ?? []) {
      await system.executor.execute(action.tool, action.args, {
        actor: action.role === 'operator' ? { role: 'operator' } : actor,
        runId,
        faults: null,
      })
    }

    // 第一层与第二层 复用确定性断言 L2 跳过只在弱模型犯错时才产生的路径证据
    await collectAssertions(simCase, system, runId, failures, 'L2')

    // communicateInfo 子串匹配 代码判定 零偏差
    const communicate = simCase.assertions.communicateInfo ?? []
    if (communicate.length > 0) {
      const agentText = readAgentMessages(system, runId).join('\n')
      for (const expected of communicate) {
        if (!agentText.includes(expected)) {
          failures.push({
            kind: 'communicate',
            message: `断言失败 回复未提到关键信息 ${expected}`,
          })
        }
      }
    }

    // 第三层 LLM judge 只评主观判据
    const rubric = simCase.assertions.judgeRubric ?? []
    if (rubric.length > 0 && options.judgeModel) {
      transcript = readTranscript(system, runId)
      judgeFailures = await judgeTranscript({ model: options.judgeModel }, rubric, transcript)
      for (const failure of judgeFailures) {
        failures.push({
          kind: 'judge',
          message: `judge 判定未通过 ${failure.rubric} ${failure.reason}`,
        })
      }
    }

    // 失败用例导出 场景与 transcript 供人工归因与回流
    if (failures.length > 0 && options.failureDir) {
      if (transcript.length === 0) {
        transcript = readTranscript(system, runId)
      }
      exportFailureStub(options.failureDir, simCase, runId, transcript, failures)
    }
  } catch (error) {
    failures.push({
      kind: 'exception',
      message: `用例执行异常 ${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`,
    })
  }

  const stateFailures = failures.filter((f) => f.kind === 'state' || f.kind === 'exception')
  system.db.close()
  return {
    caseId: simCase.id,
    category: simCase.category,
    priority: simCase.priority,
    passed: failures.length === 0,
    failures: failures.map((f) => ({ kind: f.kind, message: f.message })),
    durationMs: Date.now() - startedAt,
    turns,
    agentInputTokens: tally.inputTokens,
    agentOutputTokens: tally.outputTokens,
    agentCostUsd: undefined,
    simulatorInputTokens: simInputTokens,
    simulatorOutputTokens: simOutputTokens,
    simulatorCostUsd: undefined,
    judge: judgeFailures,
    runId,
    layer: {
      stateOk: stateFailures.length === 0,
      trajectoryOk: !failures.some((f) => f.kind === 'trajectory'),
      argsOk: !failures.some((f) => f.kind === 'args'),
      escalationOk: !failures.some((f) => f.kind === 'escalation'),
      clarifyOk: !failures.some((f) => f.kind === 'clarify'),
      gatewayOk: !failures.some((f) => f.kind === 'gateway'),
    },
  }
}
