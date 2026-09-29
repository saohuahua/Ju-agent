/**
 * 打字机追赶逻辑测试
 *
 * 显示游标必须单调推进 不越过目标 积压越大追赶越快
 * 速率与帧间隔线性换算保证帧率无关性 换算误差用近似断言约束
 */

import { describe, expect, it } from 'vitest'
import { nextCursor } from '../src/lib/use-typewriter'

describe('打字机追赶', () => {
  it('短增量按基础速率附近推进 与帧率无关', () => {
    // 积压 10 码点 速率 95cps 16ms 帧推进 1.52 码点
    expect(nextCursor(0, 10, 16)).toBeCloseTo(1.52)
    // 相同积压 100ms 推进 9.5 码点 两段小帧合计与一次长帧一致
    expect(nextCursor(0, 10, 100)).toBeCloseTo(9.5)
  })

  it('积压越大追赶越快 显示始终贴近目标', () => {
    // 积压 900 码点 速率 4545cps 100ms 追 454.5 码点
    expect(nextCursor(100, 1000, 100)).toBeCloseTo(554.5)
    // 推进量随积压单调增加 短积压走匀速 长积压加速追赶
    const short = nextCursor(0, 20, 16) - 0
    const long = nextCursor(0, 200, 16) - 0
    expect(long).toBeGreaterThan(short)
  })

  it('游标到达目标后停止 且推进不越过目标', () => {
    // 到达目标后返回目标本身 不再增长
    expect(nextCursor(1000, 1000, 100)).toBe(1000)
    expect(nextCursor(1200, 1000, 100)).toBe(1000)
    // 未越过时停在推进位置 积压 50 码点 速率 295cps 100ms 推 29.5
    expect(nextCursor(950, 1000, 100)).toBeCloseTo(979.5)
    // 推进量超过剩余积压时吸附到目标 积压 50 速率 295cps 200ms 推 59
    expect(nextCursor(950, 1000, 200)).toBe(1000)
  })

  it('长时间休眠恢复后一次追完积压 不会停留也不会越界', () => {
    // 页面休眠后帧间隔畸变 速率换算仍保证吸附到目标
    expect(nextCursor(0, 1000, 10000)).toBe(1000)
    expect(nextCursor(0, 100000, 10000)).toBe(100000)
  })
})
