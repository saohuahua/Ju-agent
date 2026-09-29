'use client'

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DeskEmpty } from '@/components/desk/DeskEmpty'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { RefreshButton } from '@/components/ui/refresh-button'
import { ModelSettingsDialog } from '@/components/ModelSettingsDialog'
import { api } from '@/lib/api'
import { useIdentity } from '@/lib/identity'

export default function SettingsPage() {
  const { role } = useIdentity()
  const [local, setLocal] = useState(false)
  useEffect(() => {
    setLocal(['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname))
  }, [])
  const health = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    enabled: role !== 'customer',
  })
  const modelSettings = useQuery({
    queryKey: ['model-settings'],
    queryFn: api.modelSettings,
    enabled: role === 'supervisor',
  })

  return (
    <>
      {role === 'customer' ? (
        <DeskEmpty
          title="运行设置仅供团队查看"
          description="请从客户服务入口继续处理自己的售后问题"
        />
      ) : (
        <div className="youju-page">
          <header className="youju-page-heading">
            <div>
              <h1>运行设置</h1>
              <p>模型连接与当前业务环境</p>
            </div>
            <RefreshButton
              variant="outline"
              disabled={health.isFetching || modelSettings.isFetching}
              onRefresh={async () => {
                await Promise.all([health.refetch(), modelSettings.refetch()])
              }}
            >
              刷新状态
            </RefreshButton>
          </header>
          <div className="flex flex-col gap-5">
            {(health.error || modelSettings.error) && (
              <Alert variant="destructive">
                <AlertDescription>
                  {health.error?.message ?? modelSettings.error?.message}
                </AlertDescription>
              </Alert>
            )}
            <Alert>
              <AlertTitle>模型连接</AlertTitle>
              <AlertDescription>
                {health.isPending
                  ? '正在读取服务状态'
                  : health.data?.modelTransport === 'live'
                    ? `真实模型已启用 · ${modelSettings.data?.model || '当前模型'}`
                    : '当前使用离线模拟模型'}
              </AlertDescription>
              {role === 'supervisor' && modelSettings.data && (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <ModelSettingsDialog
                    key={JSON.stringify(modelSettings.data)}
                    initial={modelSettings.data}
                    local={local}
                    onChanged={() => {
                      void modelSettings.refetch()
                      void health.refetch()
                    }}
                  />
                  {!local && (
                    <span className="text-sm text-muted-foreground">
                      仅本机开放 请使用 127.0.0.1 地址打开设置
                    </span>
                  )}
                </div>
              )}
              {role === 'operator' && (
                <p className="mt-3 text-sm text-muted-foreground">模型配置需要主管身份</p>
              )}
            </Alert>
            <Alert>
              <AlertTitle>费用边界</AlertTitle>
              <AlertDescription>
                真实模型调用按填写的单价估算并记账 实际费用以提供商账单为准
              </AlertDescription>
            </Alert>
            <Alert>
              <AlertTitle>业务环境</AlertTitle>
              <AlertDescription>
                当前订单与支付渠道均为模拟实现 当前身份切换不是生产认证
              </AlertDescription>
            </Alert>
          </div>
        </div>
      )}
    </>
  )
}
