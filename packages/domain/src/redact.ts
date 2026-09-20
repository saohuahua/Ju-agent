/**
 * PII 脱敏工具
 *
 * 三处防线
 * 一 夹具层只存脱敏手机号
 * 二 工具输出组装时二次过滤
 * 三 模型回复落库前做模式扫描
 */

/** 连续 11 位手机号保留前 3 后 4 */
export function maskPhone(text: string): string {
  return text.replaceAll(/(?<!\d)(1\d{2})\d{4}(\d{4})(?!\d)/g, '$1****$2')
}

/** 邮箱保留首字符与域名 */
export function maskEmail(text: string): string {
  return text.replaceAll(/([A-Za-z0-9])[^@\s]*(@[A-Za-z0-9.-]+)/g, '$1****$2')
}

/** 16 到 19 位连续数字按银行卡处理 全遮蔽 */
export function maskCardNumber(text: string): string {
  return text.replaceAll(/(?<!\d)\d{16,19}(?!\d)/g, '****')
}

/** 组合脱敏 任何要进入事件或日志的文本都过这里 */
export function redactText(text: string): string {
  return maskCardNumber(maskEmail(maskPhone(text)))
}

/** 递归脱敏对象中的所有字符串 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return redactText(value) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      result[key] = redactDeep(item)
    }
    return result as unknown as T
  }
  return value
}
