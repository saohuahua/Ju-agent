# 客户寄回网页闭环 任务 B

日期 2026-09-26

## 编码前核对与设计

本任务为产品补齐 不计为 P8 模型实验成果 不解锁 P5 不启用真实模型或资金

已核对 P6 P7 交接及正式源码 客户网页尚无结构化寄回 客户详情 DTO 只有会话摘要 客户消息契约已有 returnShipment 对象 售后关联保存于 p6_conversation_refunds 不从模型文本解析业务编号

新增 GET /api/runs/:runId/customer-progress 只读接口 先沿用身份与会话归属校验 再用 runId customerId 联结原售后记录 返回白名单 DTO 不改变客户 SSE 过滤

公开字段计划为 runId returnNo orderNo type progress canRegisterShipment shipmentRegistered trackingNo 仅公开本人原流程必要事实 trackingNo 从该会话该售后本人寄回审计记录读取 不返回整段审计 JSON 任务参数 审批令牌 执行权或费用账本

状态读取来源为 return_requests refunds approval_requests p6_effects execution_ownership 和原关联表 成功要求售后完成 退款成功 原效果成功及 P6 执行权成功共同确认 未知或矛盾资金事实保守展示待核验 审批过期按现有时钟和 expires_at 只读判断 不写回业务状态

页面复用现有客户工作区和 shadcn 组件 新增独立进度卡与寄回表单 仅服务端明确 canRegisterShipment 才可寄回 仅退款从不显示寄回表单 收货仅运营执行

请求继续使用 POST /api/runs/:runId/messages 携带 message 和 returnShipment 同一提交保存固定请求键及固定请求体 按身份 会话 售后隔离 sessionStorage 刷新和失败重试复用原键 请求发出前保存 若存储失败则阻止提交避免不可恢复的重试 修改不确定提交前先核验服务端事实

查询键包含身份和会话 使用请求取消及组件卸载隔离迟到响应 SSE 事件和连接变化触发只读刷新 并定时读取业务进度 覆盖无客户事件的业务变化 不通过 message 文本猜状态 不把 HTTP 受理或提交按钮当成退款成功

发现现有人工接管消息分支会忽略 returnShipment 并作为普通留言返回 200 本任务不改变该业务入口 页面在响应后重查公开进度 以 shipmentRegistered 判断登记结果 给统一集成者建议后续明确拒绝该字段 不能把该响应当成寄回成功

初始工作树及差异保存于 C:/Users/htlocal/AppData/Local/Temp/customer-return-ui-20260926-124648 包括已有未跟踪文件哈希与目标原文件备份 保留所有既有改动

## 已实施文件

| 文件 | 本任务修改 |
| --- | --- |
| packages/contracts/src/agent.ts | CustomerRefundProgress 最小公开 schema |
| apps/api/src/customer-progress.ts | 新增只读适配 使用原仓储 validate 校验关联 同一读取事务形成白名单 DTO |
| apps/api/src/app.ts | 仅新增 customer-progress 路由 身份检查 no-store 与统一可恢复错误 |
| apps/api/test/customer-progress.test.ts | 8 项客户权限 进度 幂等 资金和 DTO 测试 |
| apps/web/src/lib/types.ts | 对齐客户公开进度类型 |
| apps/web/src/lib/api.ts | 消息客户端可选结构化寄回与取消信号 只读进度客户端 补齐已有 health 模式类型 |
| apps/web/src/components/customer/CustomerWorkspace.tsx | 挂载进度面板 按本人恢复上次选中会话 修正旧不可用提示 |
| apps/web/src/components/customer/CustomerWorkspace.module.css | 延续原设计的进度卡 窄屏会话区最小可读高度 |
| apps/web/src/components/customer/ReturnShipmentPanel.tsx | 查询与错误恢复 结构化表单 固定请求重试 状态核验 |
| apps/web/src/components/customer/return-shipment.ts | 确定性进度文案 草稿恢复与契约长度校验 |
| apps/web/test/return-shipment.test.ts | 4 项校验 草稿隔离 客户端同键重试与未知状态测试 |
| apps/web/src/app/eval/page.tsx | 清理配置密钥开启真实模型提示 禁用仍发送旧供应商请求的网页 L2 表单 |
| 本交接与对应实验记录和证据目录 | 本任务交付材料 |

未修改 runtime agent persistence 领域规则 迁移 P6 Worker P7 网关账本 共享组合根及共享交接入口 没有新增 UI 框架或依赖 没有 Git 提交或推送

## 客户 DTO 与数据来源

接口为 `GET /api/runs/:runId/customer-progress` 返回 `{ progress: CustomerRefundProgress | null }`

该接口只允许客户读取本人会话 操作员也不能通过该接口读取其他客户进度 403 不返回关联字段 未建立普通持久退款关联时 progress 为 null 不是失败 没有从旧会话文本推导售后号

| 字段 | 来源及含义 |
| --- | --- |
| runId | 已授权原会话 事务内再查所属客户与最新状态 |
| returnNo orderNo type | p6_conversation_refunds 原关联 经现有 validate 检查冻结方案和原动作后读取 return_requests |
| progress | 读取原售后 退款 审批 原渠道效果 执行权和业务任务状态 仅映射展示 不写业务状态 |
| canRegisterShipment | 原退货已授权 awaiting_buyer_shipment 未最终投影且会话仍接受补充 资金未知和人工接管均不开放 |
| shipmentRegistered | 本人该会话该售后寄回审计存在 或原业务状态已寄回或已收货 |
| trackingNo | audit_logs 精确匹配本人 原会话 原售后与 return_shipment_recorded 只读取 trackingNo 单字段 |

所有响应使用明确字段构造 没有任务 JSON 审批 ID 令牌 执行权 token 费用信息或原始审计对象 关联不一致返回 503 和固定客户提示 不泄漏内部诊断 原 SSE 和 JSON 客户事件白名单保持不变

| progress | 页面表达 |
| --- | --- |
| awaiting_approval | 等待审批 通过前无需寄回 |
| awaiting_shipment | 退货已批准 允许时显示寄回表单 |
| awaiting_receipt | 已登记寄回 等待仓库确认收货 尚未退款 |
| processing | 退款处理中 等待资金结果确认 |
| succeeded | 模拟渠道已确认退款成功 |
| rejected expired cancelled | 明确未通过 过期或取消 无寄回入口 |
| failed | 退款未确认成功 联系售后 |
| unknown | 资金结果待核验 不重复申请 |
| human | 售后专员处理 原会话留言核验 |

succeeded 同时要求售后 completed 退款 succeeded 原 p6_effects succeeded 执行权 owner 为 p6 且 state 为 succeeded 并存在非空发送许可 任何不一致保守降为 unknown 已确认成功和资金未知优先于人工会话状态 不把会话 completed 直接当作退款成功

## 寄回请求与隔离

```json
{
  "message": "已寄回商品 请核对寄回信息",
  "returnShipment": {
    "returnNo": "原客户 DTO 的售后编号",
    "trackingNo": "客户输入的物流单号"
  }
}
```

请求通过既有 `POST /api/runs/:runId/messages` 身份由既有客户端注入 单号与服务端一致 trim 后 1 至 100 字符 不限制承运商格式 不接真实物流

请求发出前将 key returnNo trackingNo message 保存到按身份和 runId 隔离的 sessionStorage 槽位 同一次提交的重试不改变请求体或 Idempotency-Key 草稿恢复后锁定原单号 存储失败不发请求 损坏草稿不静默生成新键 按钮同步 ref 锁拦截同一事件循环双提交 服务端原幂等仍是事实保障

寄回响应不会设置本地已登记或成功标记 提交前后都重新读取业务进度 查询失败不用缓存假装新事实 业务变化拒绝寄回时展示新的服务端进度

面板按身份和会话 key 挂载 查询 key 同样包含身份及会话 复用现有身份变更请求围栏与 QueryClient 隔离 查询传入 AbortSignal 表单卸载终止本地请求并忽略迟到回调 已保存草稿不因切页删除 SSE 序号与连接变化触发重查 每 3 秒轮询补足没有公开事件的业务变化

刷新恢复上次本人会话并从服务端读取状态 SSE 仍使用原序号去重 断网暂停查询时显示离线提示并隐藏操作 网络错误给出重新读取入口 空关联不显示虚构的售后卡

## 验收结果

API 定向 34/34 Web 32/32 通过 API Web contracts 非增量类型检查通过 定向 ESLint 与修改范围 git diff --check 通过 没有运行 build 没有宣称全仓最终集成通过

正式浏览器 Chrome 通过桌面 1440×1000 窄屏 390×844 键盘 Enter 提交和空单号反馈 核心退货流程由正式 `/workbench` 发起 对接真实 main.ts 与独立本地 API 离线协议和模拟渠道 未使用静态 HTML 或纯 Mock 页面

核心流程 run_fbc9f716-ccaf-4047-90c7-82b0c673e89f 售后 RT-2026-0002 退款 RF-2026-0002

- 寄回网络失败后刷新 原键 c6617833-a656-49ef-a238-7e9f5236d561 与请求体完全一致
- 同请求 HTTP 重放仍为一条受理命令和一条寄回审计
- 收货前 submissions 0 charges 0
- 运营收货后 submissions 1 charges 1 售后 completed 退款 succeeded 客户 run.completed 一次 成功消息一次
- 重启本次 API 实际断开 SSE 页面自动续传 最终刷新保持相同事实
- 另一个客户仅退款页面没有寄回表单 已确认模拟退款的渠道也是一笔
- 额外退货浏览器测试同步双提交只发一次请求 真实 API 已受理时切换新会话及身份 再交还真实响应 不串数据 返回原会话正确读取 buyer_shipped

详细日志 原始请求 DTO 数据库备份 渠道计数 客户事件以及源码哈希见 [实验记录](../experiments/customer-return-shipment-ui.md) 和 [归档摘要](../experiments/customer-return-shipment-ui-evidence/summary.json)

截图 [桌面最终状态](../experiments/customer-return-shipment-ui-evidence/desktop-final.png) [窄屏最终状态](../experiments/customer-return-shipment-ui-evidence/mobile-final.png) [同键失败重试](../experiments/customer-return-shipment-ui-evidence/desktop-network-retry.png)

## 已知限制与统一集成清单

1. 原人工接管消息分支忽略 returnShipment 的问题已在后续修复中关闭 现返回 409 且不写入 普通留言仍可发送 见 [接口修复验收](human-return-fix.md)
2. sessionStorage 在同标签页刷新与路由切换中保留 关闭标签页或清除站点存储后不能保证复用客户端旧键 服务端售后状态及幂等校验仍防止再次推进 已登记单号修改未提供产品入口 需人工核验
3. legacy 或无普通持久关联会话返回空进度 未扩展其他退款服务或历史迁移 已有聊天状态和历史消息可保留较早表述 新进度卡是本次提供的结构化当前事实
4. 旧 L2 网页表单不支持后端显式 simulation 协议 已明确禁用并提示 后续评测页面接入另行实施 没有重做 P7
5. 当前演示身份和本地模拟渠道不代表生产身份 真实退款 真实模型质量或部署验收 没有跨浏览器全矩阵测试 没有 P8 模型实验 没有解锁 P5
6. 集成时保留任务 A 的 runtime 改动 本任务 app.ts 只有新增 import 和只读路由 应按该范围合并 不用整个文件覆盖并行工作
7. 合并后复核 CustomerRefundProgress 与前端本地类型 字段过滤 资金成功联合条件 并重跑本交接定向命令 再由统一集成者执行全仓验收
8. 建议共享入口新增产品补齐记录 链接本交接及实验记录 不将 66 项定向测试写成全仓总数 不写入 P8 多 Agent 实验成绩
