# 最近订单查询与选单

日期：2026-09-28

## 已交付行为

默认 simulation 客户入口的新会话支持直接发送“商品收到后无法开机 我想退货”。系统按当前会话客户查询最近五笔订单，展示商品、数量、下单时间、状态、整单实付金额和订单号。用户点击商品后继续原会话，不需要重新描述诉求或手工输入单号。

支持查看更多、重新查询、空订单提示、失败后重试及找不到订单转人工。仅一笔候选也不自动提交。一单多件时可以选择某件商品或明确选择全部商品；某件商品的选择当前指该订单行全部数量，不支持部分数量退货。界面金额是整单实付，不是所选商品预计退款额。

无法开机、不能开机、开不了机、不开机在离线脚本中映射为 quality。它只是对用户诉求分类，不代表系统已经鉴定商品故障，也不自动批准退货。资格、金额、审批和退款仍由现有领域流程决定。

## 数据与协议

- `ListMyOrdersInput` 只接受 offset，默认零，范围零至一万，不接受 customerId。
- `SqliteOrderRepository.listByCustomer` 的客户身份来自持久任务，查询按 created_at 与 order_no 倒序，取六条判断是否有下一页，每页公开五条。
- `list_my_orders` 只在新版持久会话工具目录启用，不加入历史 Agent 的全局工具注册表。
- `OrderCandidates` 是工具输出与公开事件共用的字段白名单，只有订单号、状态、金额、币种、时间及商品标识、名称、数量，不公开客户资料或支付信息。
- `order.candidates` 与工具结果在同一确认事务落库，通过现有客户事件接口和 SSE 输出。`run.paused.missingSlot` 为 orderNo 或 itemIds 时展示选单卡片。
- 前端从事件归约候选，不另存订单副本。刷新回放、重复事件和身份切换沿用已有订阅隔离。
- 点击选单通过原消息接口提交明确的订单号和商品标识，复用请求幂等键并添加同步点击锁。服务端重新校验订单归属和商品归属，不信任浏览器提交的选择。
- 原始用户消息和 ask_user 的工具结果回复都参与诉求恢复。工具返回的候选订单号不参与用户选择提取，避免默认选中第一笔。

## 版本与使用

新会话快照使用 `refund-orders-v2` 和 `durable-refund-orders-v2`。旧 `refund-v1` 与 `readonly-v1` 会话继续按冻结版本恢复，不自动获得新工具。

使用前让开发 API 加载最新源码，并在客户工作台点“新建咨询”发起新会话。已经卡在旧版订单号补问的会话不会自动迁移。现有容器或生产前端构建不会因为源码变更自动更新；本次未 build、未更新容器镜像、未开启真实模型。

演示订单来自当前数据库，列表展示不保证符合售后条件。基线订单时间固定在 2026-09-20 附近，按实际系统时间运行时，部分订单可能已经超过政策期限。不得为使演示通过而修改用户现有订单；需要演示政策成功分支时使用独立测试库。

当前离线识别仍是有限规则，不等于完整自然语言理解。订单标识解析沿用 SO-2026 四位编号格式；卡片展示已有商品名称及数量，数据库没有独立规格字段。分页使用 offset，查询间新增订单可能造成页边界变化，订单归属及最终业务核验不受影响。

## 验证记录

接口专项及已有退款回归 34 项通过，前端事件与相关回归 21 项通过，契约测试 15 项通过，共 70 项。新增覆盖当前用户订单、分页、无订单、查询失败重试、跨客户订单拒绝、多商品选择、原诉求恢复、相同请求键重放、Worker 重建和旧版本能力隔离。

```powershell
pnpm --filter @aftersales/api exec vitest run test/order-selection.test.ts test/conversation-refund.test.ts test/customer-events.test.ts
pnpm --filter web exec vitest run test/order-selection.test.ts test/runReducer.test.ts test/event-stream.test.ts test/customer-view.test.ts test/return-shipment.test.ts
pnpm --filter @aftersales/contracts test
```

全仓非增量类型检查 `pnpm -r --workspace-concurrency=2 exec tsc --noEmit --incremental false` 通过。本次修改的 TypeScript 和 TSX 文件已通过 ESLint、Prettier 格式化及 Git 空白检查。未执行 build。

退款回归初次因测试证据目录 EPERM 失败，允许终端写入后完整重跑通过，不把第一次运行记为通过。本轮退款回归原始证据在 `docs/experiments/p6-conversation-refund-evidence/2026-09-28T03-25-47.824Z`。

浏览器工具初始化返回 `Codex auth token is unavailable`，本次未完成真实浏览器点击、窄屏截图或视觉验收。Worker 重建验证的是原数据库上的对象重建，不冒充进程强退重启测试。
