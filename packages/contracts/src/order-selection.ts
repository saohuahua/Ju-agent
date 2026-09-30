import { z } from 'zod'

/** 候选订单只公开选单所需字段 不包含客户和支付信息 */
export const OrderCandidates = z.object({
  orders: z
    .array(
      z.object({
        orderNo: z.string().min(1),
        status: z.string(),
        totalAmountCents: z.number().int().nonnegative(),
        currency: z.string(),
        createdAt: z.string(),
        items: z.array(
          z.object({
            itemId: z.string().min(1),
            title: z.string(),
            quantity: z.number().int().positive(),
          }),
        ),
      }),
    )
    .max(5),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
})

export const ListMyOrdersInput = z
  .object({
    offset: z.number().int().min(0).max(10000).default(0),
  })
  .strict()
