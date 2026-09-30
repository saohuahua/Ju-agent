import type { ChatModel } from '../../agent/src/model.js'
import { P7Error, type P7Snapshot } from '../../contracts/src/p7-model-gateway.js'
import type { P7Ledger } from '../../persistence/src/p7-ledger.js'
import { P7Gateway, type P7Transport } from '../../runtime/src/p7-gateway.js'

export type P7EvalRole = 'main_agent' | 'simulator' | 'judge'

/** 实验身份由调用方保存 重复轮次不代表失败重试 */
export interface P7EvalIdentity {
  experimentId: string
  caseId: string
  repeat: number
}

export interface P7EvalRoleConfig {
  snapshot: P7Snapshot
  transport: P7Transport
}

/** 三个角色共用唯一账本 不创建预算或读取凭据 */
export interface P7EvalModelsInput {
  identity: P7EvalIdentity
  ledger: P7Ledger
  roles: Record<P7EvalRole, P7EvalRoleConfig>
  signal?: AbortSignal
}

/** 子运行标识保留角色快照归因 不等同于业务运行标识 */
export interface P7EvalModels {
  identity: Readonly<P7EvalIdentity>
  runIds: Readonly<Record<P7EvalRole, string>>
  agentModel: ChatModel
  userModel: ChatModel
  judgeModel: ChatModel
}

/** 每次流请求分配逻辑轮次 供应商尝试完全交由网关管理 */
export function createP7EvalModels(input: P7EvalModelsInput): P7EvalModels {
  const { experimentId, caseId, repeat } = input.identity
  if (
    typeof experimentId !== 'string' ||
    !experimentId.trim() ||
    typeof caseId !== 'string' ||
    !caseId.trim() ||
    !Number.isSafeInteger(repeat) ||
    repeat < 1
  )
    throw new P7Error('CONFIG')
  const identity = Object.freeze({ experimentId, caseId, repeat })
  const roles = ['main_agent', 'simulator', 'judge'] as const
  const runIds = {} as Record<P7EvalRole, string>
  const models = {} as Record<P7EvalRole, ChatModel>
  const signal = input.signal
  for (const role of roles) {
    const { snapshot, transport } = input.roles[role]
    const gateway = new P7Gateway(snapshot, input.ledger)
    if (gateway.snapshot.mode !== 'simulation' || transport.mode !== 'simulation')
      throw new P7Error('LIVE_DISABLED')
    // 元组编码避免分隔符碰撞 同一身份重建不能逃过账本唯一约束
    const runId = JSON.stringify(['p7-eval-v1', experimentId, caseId, repeat, role])
    runIds[role] = runId
    let callRound = 0
    models[role] = {
      supportsCancellation: true,
      info: { provider: gateway.snapshot.provider, model: gateway.snapshot.model },
      stream(request, callSignal) {
        if (callRound === Number.MAX_SAFE_INTEGER) throw new P7Error('CONFIG')
        // 内存序号只用于本实例的新调用 不提供跨进程恢复或外层重试
        const operationId = JSON.stringify([runId, ++callRound])
        const combined =
          signal && callSignal ? AbortSignal.any([signal, callSignal]) : (signal ?? callSignal)
        return gateway.chatModel(runId, role, transport, combined, operationId).stream(request)
      },
    }
  }
  return {
    identity,
    runIds: Object.freeze(runIds),
    agentModel: models.main_agent,
    userModel: models.simulator,
    judgeModel: models.judge,
  }
}
