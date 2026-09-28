// 普通 HTTP 环境可能缺少原生 UUID 方法 使用安全随机字节兼容
export function createRequestKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('当前浏览器无法生成安全请求标识')
  }

  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  // 设置 UUID 版本和变体位
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
