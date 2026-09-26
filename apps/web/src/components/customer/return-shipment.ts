import type { CustomerRefundProgress } from '@/lib/types'

/** 展示只接受服务端进度 不读取助手文字 */
export const REFUND_PROGRESS_TEXT: Record<CustomerRefundProgress['progress'], string> = {
  awaiting_approval: '等待审批 通过前无需寄回',
  awaiting_shipment: '退货已批准 请登记寄回物流单号',
  awaiting_receipt: '已登记寄回 等待仓库确认收货 尚未退款',
  processing: '退款正在处理 请等待资金结果确认',
  succeeded: '模拟渠道已确认退款成功',
  rejected: '售后申请未通过 不可登记寄回',
  expired: '售后审批已过期 请联系售后专员',
  cancelled: '售后申请已取消',
  failed: '退款未确认成功 请联系售后专员处理',
  unknown: '资金结果待核验 请联系售后专员 请勿重复申请退款',
  human: '售后专员正在处理 请在原会话留言核实进度',
}

export interface ShipmentSubmission {
  key: string
  returnNo: string
  trackingNo: string
  message: string
}

export function shipmentStorageKey(token: string, runId: string) {
  return `aftersales:return-shipment:v1:${encodeURIComponent(token)}:${encodeURIComponent(runId)}`
}

/** 服务端只限制去除首尾空白后的长度 不假设快递格式 */
export function validTrackingNo(value: string): boolean {
  return value.trim().length >= 1 && value.trim().length <= 100
}

export function readShipmentSubmission(storage: Storage, key: string): ShipmentSubmission | null {
  const raw = storage.getItem(key)
  if (!raw) return null
  const value = JSON.parse(raw) as ShipmentSubmission
  if (
    !value ||
    typeof value.key !== 'string' ||
    !value.key ||
    typeof value.returnNo !== 'string' ||
    typeof value.trackingNo !== 'string' ||
    !validTrackingNo(value.trackingNo) ||
    value.message !== '已寄回商品 请核对寄回信息'
  )
    throw new Error('寄回草稿不可恢复')
  return value
}
