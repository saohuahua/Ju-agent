'use client'

import { useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { PolicyDocument } from '@/lib/desk-api'

/**
 * 引用弹窗直接显示服务端返回的政策原文
 * 不将模型生成的摘要伪装成正式条款
 * 关闭状态由父页面控制以便在切换案件时清理旧引用
 */
export function PolicyDialog({
  document,
  onClose,
}: {
  document: PolicyDocument | null
  onClose: () => void
}) {
  const returnFocus = useRef<HTMLElement | null>(null)

  return (
    <Dialog
      open={Boolean(document)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"
        onOpenAutoFocus={() => {
          // 受控弹窗没有内置触发器 因此记录实际打开引用的按钮
          const active = window.document.activeElement
          returnFocus.current = active instanceof HTMLElement ? active : null
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnFocus.current?.isConnected) returnFocus.current.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{document?.title}</DialogTitle>
          <DialogDescription>
            政策版本 {document?.policyVersion ?? '未提供'} · 来源 {document?.source ?? '政策库'}
          </DialogDescription>
        </DialogHeader>

        <div className="youju-policy-text">{document?.content}</div>
        {/* 检索片段与原文分别展示 引用身份用于回查对应内容版本 */}
        {document?.chunk && (
          <div className="youju-policy-text">
            <strong>命中片段 {document.chunk.position + 1}</strong>
            <p>{document.chunk.content}</p>
            <p className="break-all">片段标识 {document.chunk.chunkId}</p>
            <p>
              原文偏移 {document.chunk.start} 至 {document.chunk.end}
            </p>
          </div>
        )}
        {document?.revision && (
          <p className="youju-source break-all">内容版本 {document.revision}</p>
        )}
        <p className="youju-source">来源标识 {document?.articleId} · 政策解释不替代业务规则校验</p>
      </DialogContent>
    </Dialog>
  )
}
