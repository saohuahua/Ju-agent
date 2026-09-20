/**
 * 评测运行器
 *
 * 每条用例独立装配 夹具重置 冻结时钟 脚本化模型
 * 执行流程 重置 -> 驱动回合与审批 -> 断点恢复 -> 数据库终态与轨迹断言
 * 用例之间零共享 保证同构重跑结果一致
 */

import { ProcessCrashError } from '@aftersales/tools'
import { FaultController } from '@aftersales/tools'
import { ScriptedModel, PROMPT_VERSION } from '@aftersales/agent'
import type { ChatModel } from '@aftersales/agent'
import type { AgentOutput, EvalCase } from '@aftersales/contracts'
import { APPROVAL_TTL_MS } from '@aftersales/domain'
import { FrozenClock } from '@aftersales/domain'
import type { Actor } from '@aftersales/domain'
import { BASELINE_FROZEN_TIME, composeSystem, type ComposedSystem } from '@aftersales/runtime'
import type { CaseDetail, ToolExecution } from './types.js'
import {
  checkStateAssertion,
  checkTrajectory,
  checkToolArgs,
  type AssertionFailure,
} from './validators.js'

/** 评测执行器的工具超时 覆盖描述符默认值 加速故障注入用例 */
const EVAL_TIMEOUT_MS = 300

export interface RunCaseOptions {
  /** 注入真实模型时忽略用例脚本 模型按提示词自由决策 断言仍以终态为准 */
  model?: ChatModel
}

function actorFor(caseActor: EvalCase['actor']): Actor {
  return { role: caseActor.role, customerId: caseActor.customerId }
}

/** 读取用例的全部工具执行记录 */
function readExecutions(system: ComposedSystem): ToolExecution[] {
  const rows = system.db
    .prepare(
      'SELECT tool_name, args_json, status, error_code, attempt FROM tool_executions ORDER BY id',
    )
    .all() as Array<{
    tool_name: string
    args_json: string
    status: string
    error_code: string | null
    attempt: number
  }>
  return rows.map((row) => ({
    toolName: row.tool_name,
    args: JSON.parse(row.args_json) as Record<string, unknown>,
    status: row.status as 'succeeded' | 'failed',
    errorCode: row.error_code,
    attempt: row.attempt,
  }))
}

/** 单条用例执行 */
export async function runCase(
  evalCase: EvalCase,
  options: RunCaseOptions = {},
): Promise<CaseDetail> {
  const startedAt = Date.now()
  const clock = new FrozenClock(evalCase.frozenTime ?? BASELINE_FROZEN_TIME)
  const model = options.model ?? new ScriptedModel(evalCase.modelScript as unknown as AgentOutput[])
  const system = composeSystem({
    clock,
    model,
    timeoutOverrideMs: EVAL_TIMEOUT_MS,
    maxSteps: evalCase.maxSteps,
    // 契约层 table 为宽字符串 持久层类型更窄 校验已在契约层完成
    fixturePatch: evalCase.fixturePatch as never,
  })
  const actor = actorFor(evalCase.actor)
  const faults = new FaultController((evalCase.faultPlan ?? []) as never)

  const failures: AssertionFailure[] = []

  try {
    const run = await system.runService.start({
      customerId: evalCase.actor.customerId ?? 'C1001',
      promptVersion: PROMPT_VERSION,
      model: model.info.model,
      faultPlan: evalCase.faultPlan ?? [],
    })
    const toolContext = { actor, runId: run.runId, faults }

    // 驱动首回合
    let outcome = await driveTurn(
      system,
      run.runId,
      evalCase.turns[0]!.userMessage,
      toolContext,
      true,
    )
    let turnIndex = 1

    // 回合与审批的推进循环
    for (;;) {
      if (outcome === 'awaiting_input' && turnIndex < evalCase.turns.length) {
        outcome = await driveTurn(
          system,
          run.runId,
          evalCase.turns[turnIndex]!.userMessage,
          toolContext,
          false,
        )
        turnIndex += 1
        continue
      }
      if (outcome === 'awaiting_approval' && evalCase.approvalAction) {
        outcome = await driveApproval(
          system,
          run.runId,
          clock,
          evalCase.approvalAction,
          toolContext,
        )
        continue
      }
      break
    }

    // 运行结束后的运营动作 收货登记等闭环
    for (const action of evalCase.operatorActions ?? []) {
      await system.executor.execute(action.tool, action.args, {
        actor: action.role === 'operator' ? { role: 'operator' } : actor,
        runId: run.runId,
        faults: null,
      })
    }

    await collectAssertions(evalCase, system, run.runId, failures)
  } catch (error) {
    failures.push({
      kind: 'state',
      message: `用例执行异常 ${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`,
    })
  }

  const stateFailures = failures.filter((f) => f.kind === 'state')
  const trajectoryFailures = failures.filter((f) => f.kind === 'trajectory')
  return {
    caseId: evalCase.id,
    category: evalCase.category,
    priority: evalCase.priority,
    passed: failures.length === 0,
    failures: failures.map((f) => f.message),
    durationMs: Date.now() - startedAt,
    layer: {
      stateOk: stateFailures.length === 0,
      trajectoryOk: trajectoryFailures.filter((f) => !f.message.includes('参数')).length === 0,
      argsOk: trajectoryFailures.filter((f) => f.message.includes('参数')).length === 0,
      escalationOk: !failures.some((f) => f.kind === 'escalation'),
      clarifyOk: !failures.some((f) => f.kind === 'clarify'),
      gatewayOk: !failures.some((f) => f.kind === 'gateway'),
    },
  }
}

/** 单个回合 首回合与补问走不同入口 crash 时先走断点恢复 */
async function driveTurn(
  system: ComposedSystem,
  runId: string,
  message: string,
  toolContext: { actor: Actor; runId: string; faults: FaultController | null },
  isFirst: boolean,
): Promise<string> {
  try {
    if (isFirst) {
      return await system.runner.start(runId, message, toolContext)
    }
    return await system.runner.continueWithMessage(runId, message, toolContext)
  } catch (error) {
    if (error instanceof ProcessCrashError) {
      // 进程中断语义 恢复时解除故障注入 续跑后终态交给断言判定
      await system.runner.resumeFromCheckpoint(runId, { ...toolContext, faults: null })
      return 'crash_recovered'
    }
    throw error
  }
}

/** 审批决定驱动 */
async function driveApproval(
  system: ComposedSystem,
  runId: string,
  clock: FrozenClock,
  action: 'approve' | 'reject' | 'expire',
  toolContext: { actor: Actor; runId: string; faults: FaultController | null },
): Promise<string> {
  const pending = await system.approvalService.listPending()
  const approval = pending.find((item) => item.runId === runId)
  if (!approval) {
    return 'approval_missing'
  }
  if (action === 'expire') {
    clock.advanceBy(APPROVAL_TTL_MS + 60_000)
    return system.runner.resumeAfterApproval(
      runId,
      approval.approvalId,
      'expired',
      'supervisor',
      toolContext,
    )
  }
  const decision = action === 'approve' ? 'approved' : 'rejected'
  await system.approvalService.decide({ role: 'supervisor' }, approval.approvalId, decision)
  return system.runner.resumeAfterApproval(
    runId,
    approval.approvalId,
    decision,
    'supervisor',
    toolContext,
  )
}

/** 断言收集 数据库终态 轨迹 升级 补问 网关扣款 */
async function collectAssertions(
  evalCase: EvalCase,
  system: ComposedSystem,
  runId: string,
  failures: AssertionFailure[],
): Promise<void> {
  const executions = readExecutions(system)
  const input = {
    runId,
    queryTable: system.queryTable,
    executions,
    gatewayCharges: system.gateway.totalSuccessfulCharges(),
  }

  for (const assertion of evalCase.assertions.expectedState) {
    const failure = checkStateAssertion(assertion, input)
    if (failure) failures.push(failure)
  }

  const trajectory = evalCase.assertions.trajectory
  if (trajectory) {
    failures.push(...checkTrajectory(trajectory, input))
    if (trajectory.toolArgs) {
      failures.push(...checkToolArgs(trajectory.toolArgs, input))
    }
  }

  const runRow = system.queryTable('agent_runs', { run_id: runId })[0]
  if (evalCase.assertions.expectEscalation) {
    if (runRow?.status !== 'escalated') {
      failures.push({
        kind: 'escalation',
        message: `断言失败 期望升级人工 实际运行状态 ${String(runRow?.status)}`,
      })
    }
  }
  if (evalCase.assertions.expectClarify) {
    const paused = system.queryTable('agent_events', { run_id: runId, type: 'run.paused' })
    const clarified = paused.some((row) => String(row.payload_json).includes('awaiting_input'))
    if (!clarified) {
      failures.push({ kind: 'clarify', message: '断言失败 期望出现补问暂停 事件中未发现' })
    }
  }
  if (evalCase.assertions.expectGatewayCharges !== undefined) {
    const actual = system.gateway.totalSuccessfulCharges()
    if (actual !== evalCase.assertions.expectGatewayCharges) {
      failures.push({
        kind: 'gateway',
        message: `断言失败 网关成功扣款 ${actual} 次 期望 ${evalCase.assertions.expectGatewayCharges} 次`,
      })
    }
  }
}
