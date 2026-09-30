'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { RefreshButton } from '@/components/ui/refresh-button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { createRequestKey } from '@/lib/request-key'
import type { CustomerRefundProgress } from '@/lib/types'
import {
  REFUND_PROGRESS_TEXT,
  readShipmentSubmission,
  shipmentStorageKey,
  validTrackingNo,
  type ShipmentSubmission,
} from './return-shipment'
import styles from './CustomerWorkspace.module.css'

export function ReturnShipmentPanel({
  token,
  runId,
  sequence,
  connected,
}: {
  token: string
  runId: string
  sequence: number
  connected: boolean
}) {
  const query = useQuery({
    queryKey: ['customer', 'refund-progress', token, runId],
    queryFn: ({ signal }) => api.customerProgress(runId, signal),
    refetchInterval: 3000,
    retry: 1,
  })
  const refresh = query.refetch
  const previous = useRef({ token, runId, sequence, connected })

  // 首次挂载与身份或会话切换由查询本身负责读取
  // 连续事件合并为一次尾随刷新 定时查询仍保证持续流式输出时能够更新
  // 已有请求继续完成 避免每个事件都取消并重发同一进度查询
  useEffect(() => {
    const last = previous.current
    previous.current = { token, runId, sequence, connected }
    if (last.token !== token || last.runId !== runId) return
    if (last.sequence === sequence && last.connected === connected) return

    const timer = window.setTimeout(() => void refresh({ cancelRefetch: false }), 200)
    return () => window.clearTimeout(timer)
  }, [token, runId, sequence, connected, refresh])
  const unavailable = query.fetchStatus === 'paused' || query.isError
  // 首屏没有数据时使用独立占位 已显示表单不因后台失败而卸载
  // 缓存只用于保留用户草稿 不作为进度仍然允许提交的依据
  if (!query.data && query.fetchStatus === 'paused')
    return (
      <Alert>
        <AlertDescription>连接已离线 售后进度暂时无法核验 恢复连接后将重新读取</AlertDescription>
      </Alert>
    )
  if (!query.data && query.isPending)
    return (
      <div role="status" aria-label="正在读取售后进度">
        <span className="sr-only">正在读取售后进度</span>
        <Skeleton className="h-28 w-full" />
      </div>
    )
  if (!query.data)
    return (
      <Alert>
        <AlertDescription>
          售后进度暂时无法核验 请恢复连接后重试
          <RefreshButton variant="link" onRefresh={() => refresh()}>
            重新读取进度
          </RefreshButton>
        </AlertDescription>
      </Alert>
    )
  const progress = query.data.progress
  if (!progress) return null
  return (
    <section className={styles.refundPanel} aria-label="原售后进度">
      {unavailable && (
        <Alert>
          <AlertDescription>
            最新进度暂时无法核验 已保留填写内容 恢复连接并刷新进度后可继续提交
          </AlertDescription>
        </Alert>
      )}
      <div className={styles.refundHeading}>
        <h3>原售后进度</h3>
        <Badge variant="secondary">{progress.type === 'return' ? '退货后退款' : '仅退款'}</Badge>
      </div>
      <p className={styles.refundReference}>
        售后单 {progress.returnNo} · 订单 {progress.orderNo}
      </p>
      <p role="status">{REFUND_PROGRESS_TEXT[progress.progress]}</p>
      {progress.shipmentRegistered && (
        <p>寄回已登记{progress.trackingNo ? ` · ${progress.trackingNo}` : ''}</p>
      )}
      {progress.type === 'return' &&
      progress.canRegisterShipment &&
      !progress.shipmentRegistered ? (
        <ShipmentForm
          key={progress.returnNo}
          token={token}
          runId={runId}
          progress={progress}
          unavailable={unavailable}
          refresh={async () => {
            const result = await refresh()
            if (result.isError) throw new Error('进度读取失败')
            return result.data?.progress ?? null
          }}
        />
      ) : null}
      <RefreshButton
        variant="link"
        size="sm"
        disabled={query.isFetching}
        onRefresh={() => refresh()}
      >
        刷新进度
      </RefreshButton>
    </section>
  )
}

function ShipmentForm({
  token,
  runId,
  progress,
  unavailable,
  refresh,
}: {
  token: string
  runId: string
  progress: CustomerRefundProgress
  unavailable: boolean
  refresh: () => Promise<CustomerRefundProgress | null>
}) {
  const [tracking, setTracking] = useState('')
  const [pending, setPending] = useState<ShipmentSubmission | null>(null)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(false)
  const lock = useRef(false)
  // 保存本次点击的按钮语义 首次提交写入 pending 时不改变加载中的按钮宽度
  const retrying = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const storageKey = shipmentStorageKey(token, runId)
  useEffect(() => {
    active.current = true
    try {
      const saved = readShipmentSubmission(sessionStorage, storageKey)
      if (saved && saved.returnNo !== progress.returnNo) throw new Error('原售后关联已变化')
      setPending(saved)
      setTracking(saved?.trackingNo ?? '')
      setReady(true)
    } catch {
      setError('无法恢复寄回提交记录 请联系售后专员核验 请勿重复提交')
    }
    return () => {
      active.current = false
      controller.current?.abort()
    }
  }, [storageKey, progress.returnNo])

  async function submit() {
    if (lock.current || !ready || unavailable) return
    if (!validTrackingNo(tracking)) {
      setError('请输入 1 至 100 个字符的物流单号')
      return
    }
    lock.current = true
    retrying.current = Boolean(pending)
    setBusy(true)
    setError('')
    let persisted = Boolean(pending)
    try {
      // 发出前冻结原键和请求体 刷新与失败重试复用同一次提交
      const submission = pending ?? {
        key: createRequestKey(),
        returnNo: progress.returnNo,
        trackingNo: tracking.trim(),
        message: '已寄回商品 请核对寄回信息',
      }
      sessionStorage.setItem(storageKey, JSON.stringify(submission))
      persisted = true
      setPending(submission)
      setTracking(submission.trackingNo)
      const latest = await refresh()
      if (!active.current) return
      if (latest?.shipmentRegistered) return
      if (!latest?.canRegisterShipment || latest.returnNo !== submission.returnNo)
        throw new Error('当前不能登记寄回')
      controller.current = new AbortController()
      await api.continueRun(
        runId,
        submission.message,
        submission.key,
        { returnNo: submission.returnNo, trackingNo: submission.trackingNo },
        controller.current.signal,
      )
      if (!active.current) return
      const confirmed = await refresh()
      if (active.current && !confirmed?.shipmentRegistered)
        setError('尚未确认登记 请刷新进度或使用原请求重试 人工接管后请联系售后专员')
    } catch {
      if (active.current)
        setError(
          persisted
            ? '未能确认寄回登记 已保留本次提交 请刷新进度后使用原请求重试'
            : '浏览器无法保存提交记录 尚未发送 请允许会话存储后重试',
        )
    } finally {
      lock.current = false
      if (active.current) setBusy(false)
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      className={styles.shipmentForm}
    >
      <FieldGroup>
        <Field data-invalid={Boolean(error)} data-disabled={busy || !ready}>
          <FieldLabel htmlFor="return-tracking">寄回物流单号</FieldLabel>
          <Input
            id="return-tracking"
            value={tracking}
            onChange={(event) => setTracking(event.target.value)}
            readOnly={Boolean(pending)}
            disabled={busy || !ready}
            aria-invalid={Boolean(error)}
            aria-describedby="return-help return-feedback"
            autoComplete="off"
          />
          <FieldDescription id="return-help">
            仅用于上方原退货申请 登记后仍需等待仓库收货
          </FieldDescription>
        </Field>
      </FieldGroup>
      <div id="return-feedback" role={error ? 'alert' : 'status'}>
        {error ||
          (busy
            ? '正在核验并提交寄回信息'
            : pending
              ? '本次提交已保存 重试将使用相同单号与请求'
              : '')}
      </div>
      <Button type="submit" loading={busy} disabled={busy || !ready || unavailable}>
        {(busy ? retrying.current : Boolean(pending)) ? '使用原请求重试' : '登记寄回'}
      </Button>
    </form>
  )
}
