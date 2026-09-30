import type { P7Purpose, P7Snapshot, P7Usage } from '../../contracts/src/p7-model-gateway.js'
import type { P7Ledger } from '../../persistence/src/p7-ledger.js'
import type { P6WorkPorts } from './p6-worker.js'
import { P7Gateway } from './p7-gateway.js'
import { restoreP7Snapshot } from './p7-snapshot.js'

/** 单次供应商尝试不得自行重试 重试预占始终由 P7 统一负责 */
export type DurableModelOperation = (
  input: string,
  snapshot: P7Snapshot,
  signal: AbortSignal,
  reportUsage: (usage: P7Usage | null) => void,
) => Promise<unknown>

/**
 * 固定步骤标识下按持久认领次数区分调用组 同一认领重放仍会被账本拒绝
 * P6 认领上限乘以快照内 P7 上限构成最大供应商尝试数 不使用随机标识绕过重试限制
 * 恢复只使用命令原快照 旧 held 和 unknown 费用继续保留在同一账本
 */
export function p6GatewayModel(
  ledger: P7Ledger,
  operation: DurableModelOperation,
  purpose: P7Purpose = 'main_agent',
): P6WorkPorts['model'] {
  return async (input, config, signal, context) => {
    if (!Number.isSafeInteger(context.attempt) || context.attempt < 1)
      throw new Error('认领尝试无效')
    const snapshot = restoreP7Snapshot(config.value)
    if (
      snapshot.version !== config.snapshotId ||
      snapshot.model !== config.model ||
      snapshot.provider !== config.provider ||
      snapshot.promptVersion !== config.promptVersion
    ) {
      throw new Error('持久配置封装与模型快照不一致')
    }
    const gateway = new P7Gateway(snapshot, ledger)
    return gateway.invoke(
      {
        runId: context.runId,
        purpose,
        operationId: JSON.stringify([context.operationId, 'claim', context.attempt]),
        signal,
      },
      (attemptSignal, reportUsage) => operation(input, snapshot, attemptSignal, reportUsage),
    )
  }
}
