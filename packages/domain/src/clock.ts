/**
 * 时钟抽象
 *
 * 领域代码禁止直接取系统时间 一律注入 Clock
 * 评测使用 FrozenClock 保证政策时限判定可复现
 */

export interface Clock {
  now(): Date
  /** 评测专用 快进到指定时刻 */
  advanceTo(time: Date): void
}

/** 生产时钟 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date()
  }
  advanceTo(): void {
    throw new Error('SystemClock 不支持快进 请在测试中使用 FrozenClock')
  }
}

/** 冻结时钟 评测与本地回放使用 */
export class FrozenClock implements Clock {
  private current: Date

  constructor(initial: Date | string) {
    this.current = typeof initial === 'string' ? new Date(initial) : initial
  }

  now(): Date {
    return new Date(this.current.getTime())
  }

  advanceTo(time: Date | string): void {
    this.current = typeof time === 'string' ? new Date(time) : time
  }

  /** 快进指定毫秒 常用于审批过期场景 */
  advanceBy(ms: number): void {
    this.current = new Date(this.current.getTime() + ms)
  }
}

export function toIso(date: Date): string {
  return date.toISOString()
}
