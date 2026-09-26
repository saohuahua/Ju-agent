import { createHash } from 'node:crypto'
import {
  P7Config,
  P7Error,
  P7Price,
  P7Usage,
  type P7Snapshot,
} from '../../contracts/src/p7-model-gateway.js'

/** 固定字段顺序由契约解析生成 拒绝偷偷加入密钥或未知配置 */
export function createP7Snapshot(input: unknown): P7Snapshot {
  const config = P7Config.parse(input)
  const version = createHash('sha256').update(JSON.stringify(config)).digest('hex')
  Object.freeze(config.capabilities)
  if (config.price) Object.freeze(config.price)
  return Object.freeze({ ...config, version })
}

/** 跨进程序列化后重新校验内容哈希 不接受只有版本号的全局查询 */
export function restoreP7Snapshot(input: unknown): P7Snapshot {
  if (!input || typeof input !== 'object') throw new P7Error('CONFIG')
  const { version, ...config } = input as Record<string, unknown>
  const snapshot = createP7Snapshot(config)
  if (version !== snapshot.version) throw new P7Error('CONFIG')
  return snapshot
}

/** 整数有理数统一向上取整到人民币微元 避免浮点和小额调用漏计 */
export function p7Cost(priceInput: P7Price, usageInput: P7Usage): number {
  const p = P7Price.parse(priceInput)
  const u = P7Usage.parse(usageInput)
  const raw =
    BigInt(u.inputTokens) * BigInt(p.inputMicroPerMillion) +
    BigInt(u.outputTokens) * BigInt(p.outputMicroPerMillion) +
    BigInt(p.fixedMicroPerCall) * 1000000n
  const denominator = 1000000n * BigInt(p.fxDenominator)
  const value = (raw * BigInt(p.fxNumerator) + denominator - 1n) / denominator
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new P7Error('CONFIG')
  return Number(value)
}

/** 不依赖字符估算 使用提供商声明的整个上下文和输出上限作为保守预占 */
export function p7Reservation(snapshot: P7Snapshot): number {
  if (!snapshot.price) throw new P7Error('PRICE_MISSING')
  return p7Cost(snapshot.price, {
    inputTokens: snapshot.capabilities.contextTokens,
    outputTokens: snapshot.maxOutputTokens,
  })
}
