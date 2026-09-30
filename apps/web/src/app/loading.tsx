import { Skeleton } from '@/components/ui/skeleton'

/**
 * 路由资源尚未就绪时只替换内容区
 * 外壳保留在根布局中 导航和身份切换不随占位界面消失
 */
export default function Loading() {
  return (
    <div className="youju-page" data-route-loading role="status" aria-label="正在加载页面">
      <span className="sr-only">正在加载页面</span>
      <div aria-hidden="true" className="space-y-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-5 w-64 max-w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  )
}
