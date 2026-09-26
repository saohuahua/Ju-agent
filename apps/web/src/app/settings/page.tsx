'use client'

import { useQuery } from '@tanstack/react-query'
import { AppShell } from '@/components/AppShell'
import { DeskEmpty } from '@/components/desk/DeskEmpty'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useIdentity } from '@/lib/identity'

/** 配置尚无持久写入能力时只展示已核实状态 不提供虚假的保存按钮 */
export default function SettingsPage() {
  const { role } = useIdentity()
  const health = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    enabled: role !== 'customer',
  })

  return (
    <AppShell>
      {role === 'customer' ? (
        <DeskEmpty
          title="运行设置仅供团队查看"
          description="请从客户服务入口继续处理自己的售后问题"
        />
      ) : (
        <div className="youju-page">
          <header className="youju-page-heading">
            <div>
              <p className="youju-eyebrow">当前环境与能力边界</p>
              <h1>运行设置</h1>
              <p>服务端配置只读展示 密钥不在浏览器中保存</p>
            </div>
            <Button variant="outline" onClick={() => void health.refetch()}>
              刷新状态
            </Button>
          </header>
          <div className="flex flex-col gap-5">
            {health.error && (
              <Alert variant="destructive">
                <AlertDescription>{health.error.message}</AlertDescription>
              </Alert>
            )}
            <Alert>
              <AlertTitle>模型服务</AlertTitle>
              <AlertDescription>
                {health.isPending
                  ? '正在读取服务状态'
                  : health.data
                    ? `${health.data.modelAvailable ? '已配置模型' : '尚未配置模型'} · 提示词版本 ${health.data.promptVersion}`
                    : '暂时无法确认服务状态'}
              </AlertDescription>
            </Alert>
            <Alert>
              <AlertTitle>实验预算</AlertTitle>
              <AlertDescription>
                首轮真实实验累计上限为人民币 100 元 统一费用计量与预算拦截仍在实施中
                当前页面不提供付费实验入口
              </AlertDescription>
            </Alert>
            <Alert>
              <AlertTitle>本地演示环境</AlertTitle>
              <AlertDescription>
                当前身份为演示令牌 业务渠道为模拟实现 容器启动与进程恢复实验尚未验收
              </AlertDescription>
            </Alert>
          </div>
        </div>
      )}
    </AppShell>
  )
}
