import type { P7Snapshot } from '../../contracts/src/p7-model-gateway.js'
import type { P6ConfigSnapshot } from '../../contracts/src/p6-durable.js'

/**
 * 仅封装 P7 已生成并验证的无密钥快照 不产生第二套配置版本
 * 受理持久化完整内容 恢复时仍由 P7 校验并还原 原对象后续变化不影响命令
 */
export function p6ConfigFromP7(snapshot: P7Snapshot): P6ConfigSnapshot {
  return {
    snapshotId: snapshot.version,
    provider: snapshot.provider,
    model: snapshot.model,
    promptVersion: snapshot.promptVersion,
    value: structuredClone(snapshot),
  }
}
