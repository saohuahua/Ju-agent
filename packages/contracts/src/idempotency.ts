/**
 * 幂等键设计
 *
 * 幂等键由业务身份确定性生成 相同售后单的退款无论重试多少次都命中同一键
 * 键一旦写入幂等记录 后续重复调用直接返回已记录结果 不再触碰支付网关
 */

/** 退款幂等键 绑定售后单号 */
export function refundIdempotencyKey(returnNo: string): string {
  return `refund:${returnNo}`
}

/** 收货幂等键 同一售后单只触发一次收货退款联动 */
export function receiveGoodsIdempotencyKey(returnNo: string): string {
  return `receive-goods:${returnNo}`
}

/** 事件回放查询的游标语义 返回应补发的最小序号 */
export function nextSequenceAfter(lastEventId: number | null): number {
  return (lastEventId ?? 0) + 1
}
