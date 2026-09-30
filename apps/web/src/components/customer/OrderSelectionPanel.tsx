import { Button } from '@/components/ui/button'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { formatAmount } from '@/lib/runReducer'
import type { OrderCandidates } from '@/lib/types'

const STATUS_LABELS: Record<string, string> = {
  paid: '待发货',
  shipped: '已发货',
  delivered: '已签收',
  completed: '已完成',
  cancelled: '已取消',
}

/** 订单信息只从公开事件读取 点击后沿用当前会话和请求防重 */
export function OrderSelectionPanel({
  candidates,
  disabled,
  onSelect,
}: {
  candidates: OrderCandidates
  disabled: boolean
  onSelect(message: string): void
}) {
  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-border bg-background p-4"
      aria-label="选择售后订单"
    >
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">选择出现问题的商品</h3>
        <p className="text-sm text-muted-foreground">
          按下单时间从近到远展示 选择后继续处理刚才的诉求
        </p>
      </div>
      {candidates.orders.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>当前账号暂无订单</EmptyTitle>
            <EmptyDescription>请确认登录账号 或联系人工协助查找</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {candidates.orders.map((order) => (
        <article
          key={order.orderNo}
          className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3"
        >
          <div className="flex flex-wrap justify-between gap-2 text-sm text-muted-foreground">
            <span>
              {STATUS_LABELS[order.status] ?? '待核验'} ·{' '}
              {new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(
                new Date(order.createdAt),
              )}
            </span>
            <span>订单实付 {formatAmount(order.totalAmountCents, order.currency)}</span>
          </div>
          {order.items.map((item) => (
            <div key={item.itemId} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 break-words text-sm">
                {item.title} × {item.quantity}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                aria-label={`选择${item.title} ${order.orderNo}`}
                onClick={() => onSelect(`选择订单 ${order.orderNo} 商品 ${item.itemId}`)}
              >
                选择此商品
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="break-all text-xs text-muted-foreground">{order.orderNo}</span>
            {order.items.length > 1 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => onSelect(`选择订单 ${order.orderNo} 全部商品`)}
              >
                选择全部商品
              </Button>
            )}
          </div>
        </article>
      ))}
      <div className="flex flex-wrap gap-2">
        {candidates.nextOffset !== null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onSelect('查看更多订单')}
          >
            查看更多订单
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onSelect('重新选择订单')}
        >
          重新查询订单
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onSelect('没有我要找的订单 请转人工协助')}
        >
          没有我要找的订单
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        选择商品后将核验售后条件 具体处理结果以核验为准
      </p>
    </section>
  )
}
