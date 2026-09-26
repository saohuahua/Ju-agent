import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'

/** 空状态解释当前缺少的数据并给出下一步而不是伪造内容 */
export function DeskEmpty({ title, description }: { title: string; description: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
