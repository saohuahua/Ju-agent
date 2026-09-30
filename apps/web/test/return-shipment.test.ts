import { afterEach, expect, it, vi } from 'vitest'
import { api, setToken } from '../src/lib/api'
import {
  REFUND_PROGRESS_TEXT,
  readShipmentSubmission,
  shipmentStorageKey,
  validTrackingNo,
} from '../src/components/customer/return-shipment'

afterEach(() => vi.unstubAllGlobals())

it('单号只按契约长度校验 不限制物流公司', () => {
  expect(validTrackingNo(' 邮政 / abc 123 ')).toBe(true)
  expect(validTrackingNo('   ')).toBe(false)
  expect(validTrackingNo('a'.repeat(101))).toBe(false)
  expect(validTrackingNo('a'.repeat(100))).toBe(true)
})

it('刷新恢复原请求和身份会话隔离 损坏草稿不静默换键', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null } as Storage
  const key = shipmentStorageKey('customer-1', 'run-1')
  const draft = {
    key: 'original',
    returnNo: 'return-1',
    trackingNo: 'LOCAL',
    message: '已寄回商品 请核对寄回信息',
  }
  values.set(key, JSON.stringify(draft))
  expect(readShipmentSubmission(storage, key)).toEqual(draft)
  expect(readShipmentSubmission(storage, shipmentStorageKey('customer-2', 'run-1'))).toBeNull()
  expect(readShipmentSubmission(storage, shipmentStorageKey('customer-1', 'run-2'))).toBeNull()
  values.set(key, '{}')
  expect(() => readShipmentSubmission(storage, key)).toThrow()
})

it('消息客户端原请求重试保持结构化寄回和相同幂等键', async () => {
  const values = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => values.get(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
    dispatchEvent: vi.fn(),
  })
  setToken('cust-token-1001')
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(Response.json({ runId: 'run-1' }))
  vi.stubGlobal('fetch', fetcher)
  const shipment = { returnNo: 'return-1', trackingNo: 'LOCAL' }
  await expect(api.continueRun('run-1', '已寄回', 'same-key', shipment)).rejects.toThrow()
  await api.continueRun('run-1', '已寄回', 'same-key', shipment)
  expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1])
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
    message: '已寄回',
    returnShipment: shipment,
  })
  expect(fetcher.mock.calls[1]![1].headers['Idempotency-Key']).toBe('same-key')
})

it('未知和等待状态明确不表示成功', () => {
  expect(REFUND_PROGRESS_TEXT.unknown).toContain('待核验')
  expect(REFUND_PROGRESS_TEXT.awaiting_receipt).toContain('尚未退款')
  expect(REFUND_PROGRESS_TEXT.succeeded).toBe('模拟渠道已确认退款成功')
})
