import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { Slot } from 'radix-ui'
import { LoaderCircle } from 'lucide-react'

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-primary/80 disabled:opacity-100',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 disabled:bg-destructive/80 disabled:opacity-100 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

/**
 * loading 用于已经存在的业务提交状态 不在按钮内部发起请求或修改业务状态
 * 原内容以透明方式保留尺寸和可访问名称 图标只覆盖显示区域
 * loading 自动禁用普通按钮 调用方仍应保留业务校验和同步防重复提交锁
 * asChild 用于链接等插槽场景 不应传入 loading 导航使用 NavigationLink 的真实等待状态
 */
function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  loading,
  children,
  disabled,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    loading?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || props['aria-busy']}
      data-loading={loading || undefined}
    >
      {/* 加载图标覆盖原内容 保留内容占位和可访问名称 避免额外图标挤动按钮 */}
      {/* 插槽模式保持唯一子元素结构 导航链接应使用自己的等待反馈 */}
      {!asChild && loading !== undefined ? (
        <>
          <span className="youju-button-content">{children}</span>
          {loading && (
            <span className="youju-button-loader" aria-hidden="true">
              <LoaderCircle className="youju-spin" />
            </span>
          )}
        </>
      ) : (
        children
      )}
    </Comp>
  )
}

export { Button, buttonVariants }
