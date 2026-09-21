# 术语表 业务概念词汇一致

新业务概念进场时在此沉淀 保证代码 用例 文档用词一致

## 补偿（功能 6）

- **补偿单（compensation）** 现金红包安抚 单号 CP-* 与售后单（RT-*）退款单（RF-*）并列
- **补偿原因** 仅两种 物流延误 服务道歉 契约留有扩展位
- **分级阈值** 50 元分界 ≤5000 分自动发放（C1_auto_small）>5000 分人工审批（C2_large_approval）
  与退款大额审批阈值（5000 元）相互独立 各自政策规则
- **不可叠加** 同一订单同一原因仅一次 occupied 状态幂等拒绝
  rejected/expired/cancelled 不占位 可换原因重试
- **执行中态（executing）** 网关调用中间态 失败回 failed 可重试 与退款状态机平行
- **补偿幂等键** compensation:CP-* 与退款 refundIdempotencyKey 同构 双防线（幂等记录 + 网关键）

## 物流推送（功能 7）

- **物流事件（logistics event）** 运行中途注入的运单状态变化 落 agent_events 的 logistics.event 事件
  区别于 Agent 主动查询（get_shipment 工具）
- **混合到达语义** 会话 awaiting_input 时即达即触达 其余状态事件挂起 下一轮纳入上下文
- **触达（proactive reach-out）** Agent 因物流事件主动发消息告知客户 不等客户开口
- **运单状态（shipment status）** in_transit 运输中 delayed 延误 lost 丢件 delivered 已签收 exception 异常
- **注入方** 运营端点（operator 手动 demo）与 L2 模拟器剧本 共用同一注入服务与 API

## 既有概念（沿用 不另起名）

- **审批令牌（approval token）** 一次性 只存断点不经过模型
- **幂等键（idempotency key）** 领域记录 + 网关键 两道防线
- **能力门控** 未查订单前动作工具不出现在工具目录
- **断点恢复（checkpoint resume）** 工作流逐步存档 从事件重建续跑
