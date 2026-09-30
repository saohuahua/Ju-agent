'use client'

import { useState } from 'react'
import { Eye, EyeOff, PlugZap, Settings2 } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  api,
  currentModelToken,
  setModelToken,
  type ModelSettingsDraft,
  type ModelSettingsView,
} from '@/lib/api'

export function ModelSettingsDialog({
  initial,
  local,
  onChanged,
}: {
  initial: ModelSettingsView
  local: boolean
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [protocol, setProtocol] = useState<ModelSettingsDraft['protocol']>(initial.protocol)
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl)
  const [model, setModel] = useState(initial.model)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [inputPrice, setInputPrice] = useState(String(initial.inputCnyPerMillion ?? ''))
  const [outputPrice, setOutputPrice] = useState(String(initial.outputCnyPerMillion ?? ''))
  const [localToken, setLocalToken] = useState(currentModelToken)
  const [busy, setBusy] = useState<'test' | 'save' | 'disable' | null>(null)
  const [tested, setTested] = useState(false)
  const [testResult, setTestResult] = useState('')
  const [error, setError] = useState('')

  const close = () => {
    setOpen(false)
    setApiKey('')
    setShowKey(false)
    setTested(false)
    setTestResult('')
    setError('')
  }

  const changed = () => {
    setTested(false)
    setTestResult('')
    setError('')
  }

  const draft = (): ModelSettingsDraft => ({
    protocol,
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    inputCnyPerMillion: Number(inputPrice),
    outputCnyPerMillion: Number(outputPrice),
  })

  const valid =
    Boolean(
      localToken.trim() &&
      baseUrl.trim() &&
      model.trim() &&
      (apiKey.trim() || (initial.keyConfigured && protocol === initial.protocol)),
    ) &&
    Number(inputPrice) > 0 &&
    Number(outputPrice) > 0

  async function testConnection() {
    if (!valid) return
    setBusy('test')
    setError('')
    try {
      const result = await api.testModelSettings(draft(), localToken.trim())
      setTestResult(`连接成功 · ${result.latencyMs} ms · ${result.reply}`)
      setTested(true)
    } catch (failure) {
      setTested(false)
      setError(failure instanceof Error ? failure.message : '连接测试失败')
    } finally {
      setBusy(null)
    }
  }

  async function enable() {
    if (!valid || !tested) return
    setBusy('save')
    setError('')
    try {
      await api.enableModelSettings(draft(), localToken.trim())
      setModelToken(localToken.trim())
      onChanged()
      close()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '启用失败')
    } finally {
      setBusy(null)
    }
  }

  async function disable() {
    if (!localToken.trim()) return
    setBusy('disable')
    setError('')
    try {
      await api.disableModelSettings(localToken.trim())
      setModelToken('')
      onChanged()
      close()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '停用失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true)
        else close()
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" disabled={!local}>
          <Settings2 data-icon="inline-start" />
          模型设置
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>模型设置</DialogTitle>
          <DialogDescription>真实模型对话仅在本机启用 业务订单与支付仍为模拟</DialogDescription>
        </DialogHeader>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel>接口协议</FieldLabel>
            <Tabs
              value={protocol}
              onValueChange={(value) => {
                const next = value as ModelSettingsDraft['protocol']
                setProtocol(next)
                setBaseUrl(
                  next === 'anthropic_messages'
                    ? 'https://api.anthropic.com'
                    : 'https://api.openai.com/v1',
                )
                setModel('')
                changed()
              }}
            >
              <TabsList className="w-full">
                <TabsTrigger value="anthropic_messages">Anthropic Messages</TabsTrigger>
                <TabsTrigger value="openai_chat">OpenAI Chat</TabsTrigger>
              </TabsList>
            </Tabs>
          </Field>
          <Field>
            <FieldLabel htmlFor="model-base-url">Base URL</FieldLabel>
            <Input
              id="model-base-url"
              type="url"
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.target.value)
                changed()
              }}
              placeholder="https://api.example.com/v1"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="model-id">模型名称</FieldLabel>
            <Input
              id="model-id"
              value={model}
              onChange={(event) => {
                setModel(event.target.value)
                changed()
              }}
              placeholder="填写提供商支持的模型 ID"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="model-api-key">API Key</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="model-api-key"
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value)
                  changed()
                }}
                placeholder={
                  initial.keyConfigured ? '留空沿用当前或环境变量中的 Key' : '输入 API Key'
                }
              />
              <Button
                type="button"
                size="icon"
                variant="outline"
                title={showKey ? '隐藏 Key' : '显示 Key'}
                aria-label={showKey ? '隐藏 Key' : '显示 Key'}
                onClick={() => setShowKey((value) => !value)}
              >
                {showKey ? <EyeOff /> : <Eye />}
              </Button>
            </div>
            <FieldDescription>
              协议 地址和模型从 .env 读取 Key 只显示是否已配置 不回传浏览器
            </FieldDescription>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="model-input-price">输入价格 元每百万 token</FieldLabel>
              <Input
                id="model-input-price"
                type="number"
                min="0.000001"
                step="any"
                value={inputPrice}
                onChange={(event) => {
                  setInputPrice(event.target.value)
                  changed()
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="model-output-price">输出价格 元每百万 token</FieldLabel>
              <Input
                id="model-output-price"
                type="number"
                min="0.000001"
                step="any"
                value={outputPrice}
                onChange={(event) => {
                  setOutputPrice(event.target.value)
                  changed()
                }}
              />
            </Field>
          </div>
          <FieldDescription>
            费用按填写单价估算 并非供应商账单 最多预留人民币 100 元
          </FieldDescription>
          <Field>
            <FieldLabel htmlFor="model-local-token">本机管理口令</FieldLabel>
            <Input
              id="model-local-token"
              type="password"
              autoComplete="off"
              value={localToken}
              onChange={(event) => {
                setLocalToken(event.target.value)
                changed()
              }}
              placeholder="从 API 启动终端获取"
            />
          </Field>
        </FieldGroup>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {testResult && (
          <Alert>
            <AlertDescription>{testResult}</AlertDescription>
          </Alert>
        )}
        <DialogFooter className="flex-col sm:flex-row">
          {initial.enabled && (
            <Button variant="outline" disabled={busy !== null} onClick={disable}>
              停用真实模型
            </Button>
          )}
          <Button variant="outline" disabled={!valid || busy !== null} onClick={testConnection}>
            <PlugZap data-icon="inline-start" />
            {busy === 'test' ? '测试中' : '测试连接'}
          </Button>
          <Button disabled={!tested || busy !== null} onClick={enable}>
            {busy === 'save' ? '启用中' : '保存并启用'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
