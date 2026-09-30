# P6 普通持久会话退款闭环

日期 2026-09-26

## 编码前核对

普通持久会话仅开放查询补问和升级人工的前提成立 自动批准仍在旧同步工作流 已有审批夹具恢复不等于客户闭环

开始状态保存在 ../experiments/p6-conversation-refund-evidence/start-status.txt 保留既有未提交成果

客户 HTTP 请求由 ConversationJournal 与 P6TaskRepository 维护客户加请求键幂等 同键异参拒绝 原 commandId taskId 与完整模型 turn 检查点先持久化

新增原动作关联保存 runId customerId conversation taskId step toolCallId toolName returnNo approvalId 与自动授权任务 不通过扫描唯一悬空调用猜测关系 一个运行只允许一个未结束退款流程

领域建单抽出同步方案准备 共用 AfterSaleService 的政策 归属 重复售后检查与状态迁移 持久仓储在同一租约围栏事务读取事实并写入售后 退款 执行权 审批断点 原动作关联和自动批准任务 不跨 await 持有数据库事务

需要审批沿用现有审批决定及执行意图事务 再由既有 P6OwnedAfterSale 消费令牌并受理 自动批准同样接管 ready 执行权并持久受理 不调用 executeRefund 或旧 WorkflowEngine 资金路径

领域业务幂等继续由订单已有活跃或已完成退款检查 refund:returnNo 与渠道业务键维护 重复模型动作不会创建第二笔退款 sending unknown unassigned 不重新获权

退货等待任务不是退款完成 原动作保持挂起 客户补充消息绑定原流程 仅受控寄回工具可推进 收货命令验证原授权及业务金额后转绑 ready 且无 token 的 holder 使用原退款单和业务键

结果投影按明确原动作关联最多一次 完成状态由退款及售后领域记录确定 模型只取证补问与解释 不允许模型文本宣告资金成功 审批拒绝过期与资金未知保留真实非成功结果

继续使用 P7Gateway 同库共享账本 冻结快照 取消信号与逐尝试费用 网关错误不经 Worker 再次调用模型 进程退出后的未确认请求保留未知费用 不改 P7 评测身份或 live 禁用条件

## 已实现调用链

`POST /api/runs` 或补问 `POST /api/runs/:runId/messages` → ConversationJournal 持久受理 → conversation Worker → P7Gateway 离线协议查单 政策与补问 → 确认原 agent.turn → P6ConversationRefundRepository.submit → AfterSaleService.prepareReturnRequest 与 ApprovalService.prepare → 围栏事务落业务及关联

自动批准 → 原 refund 单及 execution_ownership 同事务登记 → takeoverWithCommand → P6TaskRepository.accept → business-accepted → DurableBusiness Worker

主管批准 → 原决定与 approval_execution_intents 原子写入 → DurableBusiness.acceptApproval → P6OwnedAfterSale → P6AfterSaleRepository 消费原令牌并受理 → 同一 business Worker

两条资金路径均为 executionOwnershipPreparePayment → 原 p6PrepareBusinessPayment → 提交 sending 与 p6_effects → 本机独立模拟渠道 execute 或 query → 原 settle 围栏 → executionOwnershipApplyPayment → 原退款 售后 幂等记录及执行权终态 → 精确原调用及客户事件投影

普通持久入口不调用 WorkflowEngine.executeRefund 路径 原引擎和 legacy 入口没有被删除

## 稳定关联与等待恢复

新增 p6_conversation_refunds 只保存业务关联和投影游标 不是第二套资金状态机 每个 run 最多一个退款流程 原 commandId 由 origin_task_id 对应 p6_tasks 追溯 绑定 step_key tool_call_id tool_name return_no 原领域方案及 approval_id 自动授权另保存 authorization_task_id

主管任务通过唯一 approval_id 关联原授权 收货任务使用原 receiveGoodsIdempotencyKey 与已校验的 approvalId 或 authorizationTaskId 原退款始终使用 refund:returnNo 不使用运行编号作为资金幂等键

建单准备复用原领域方法 原异步服务仍调用同一准备方法 SQLite 受理使用原仓储同步方法 业务编号计数也在外层围栏事务内 失败全量回滚 不是跨 await 保持事务

等待期间不提前回填退款 tool_result 也不调用模型续规划 客户普通补充消息按原流程落库 回复不会被合成为退款成功的工具结果 原动作真实结果产生后 上下文先配对真实结果再交付等待期间的补充消息

寄回支持同一客户消息 HTTP 接口的可选结构化字段

```json
{
  "message": "已寄回商品",
  "returnShipment": {
    "returnNo": "从原流程返回的售后单号",
    "trackingNo": "本地模拟寄回单号"
  }
}
```

该字段必须匹配会话原售后单并处于已授权待寄回状态 不从任意自然语言猜测寄回单号 不将客户寄回声明当作仓库收货 现有客户网页尚未新增结构化寄回控件 本轮正式验收入口为 HTTP 也保留现有运营登记寄回接口

收货仍使用仅运营或主管可调用的 `/api/operations/receive-goods` 收货事务验证原授权和原退款 后转绑 ready 且无 token 的 holder 不对 sending unknown unassigned 重新授权 自动批准退货与主管批准退货均覆盖

业务结果写回原动作检查点及 agent.tool_results 与 projected 游标处于一个事务 等待和未知只发布进度 不消耗原调用最终结果槽 已确认成功要求售后 退款 原渠道效果及执行权一致 人工处理状态保留 资金事实不能被取消或接管抹去

## 模型与范围边界

组合根同时装配持久会话和持久业务 且原快照 toolVersion 为 refund-v1 时才开放两个退款工具 旧 readonly-v1 快照恢复不会升级权限 正式 simulation 装配使用 `conversationDemoOptions(true)` 不加载 .env

P7Gateway 继续使用业务库同一共享账本 供应商瞬态重试最多按原快照执行三次 Worker 对 P7Error 不再重新调用模型 强退后仅重做未确认轮次 仍受任务累计次数与原费用预占限制 新增跨轮 toolCallId 重用检查

本轮已迁移仅退款与退货后退款 客户退款流程每个运行限一个售后 未迁移的补偿 价保 换货 取消动作不进入白名单 会明确停止或升级人工 既有审批夹具对换货及补偿价保的旧集成保持兼容 不代表其普通客户发起流程已迁移

legacy 普通入口 旧同步自动批准资金流程和裸模型装配仍存在于显式持久模式之外 不声明全部 P6 完成 不声明所有真实付费入口已受控

## 本轮修改文件

- `packages/contracts/src/agent.ts` 客户补充消息结构化寄回契约
- `packages/domain/src/services/after-sale-service.ts` 共用同步领域建单准备
- `packages/domain/src/services/approval-service.ts` 共用原审批生成
- `packages/persistence/src/business-repositories.ts` 原行映射的同步事务入口
- `packages/persistence/src/p6-migration.ts` 原动作业务关联表
- `packages/persistence/src/db.ts` 独立测试夹具重置时清理新增关联 不操作用户库
- `packages/persistence/src/p6-conversation-refund.ts` 新增受理 自动授权收货及精确投影适配
- `packages/persistence/src/conversation-journal.ts` 等待期间补充幂等与原流程绑定
- `packages/persistence/src/execution-ownership-p6.ts` 发送前原会话关联校验
- `packages/runtime/src/durable-conversation.ts` 退款动作交接 工具身份及模型重试边界
- `packages/runtime/src/durable-business.ts` 原审批及自动授权收货 接入精确投影与实验边界
- `packages/runtime/src/compose.ts` 共同装配领域准备服务
- `packages/runtime/src/conversation-demo.ts` 显式离线退款演示协议
- `packages/agent/src/context.ts` 等待期间补充消息按真实结果配对
- `apps/api/src/app.ts` 持久客户消息与模式标识
- `apps/api/src/main.ts` simulation 不读取 .env 并装配离线退款模式
- `apps/api/test/conversation-refund.test.ts` 新增 HTTP 业务及安全测试
- `apps/api/test/conversation-refund-process.test.ts` 新增正式 HTTP 子进程恢复矩阵
- `apps/api/test/fixtures/refund-conversation-options.ts` 新增确定性原生离线模型协议
- `apps/api/test/fixtures/conversation-refund-process.ts` 新增仅播种基础订单的进程夹具
- 本交接 实验记录 证据目录及交接备案入口与阶段验收记录

P7 评测工厂 费用报告 正式评测源码及账本身份字段未修改

## 验收与下一步

后续更新 已识别的 legacy API 与默认政策 scorer 旁路已按最小范围关闭 见 [P7 入口收口](p7-entry-closure.md) 下方全用途治理为本轮当时的历史交接 不应据此重做已有 P7 核心或默认扩展自动费用对账与评测续跑

实测命令 数量 渠道及账本证据见 [实验记录](../experiments/p6-conversation-refund.md) 全仓最终结果以该记录为准 不以中途定向通过替代

最终全仓 586/586 通过 新增 28 项已包含其中 全仓类型 ESLint 和差异检查通过 正式离线 L1 数据集另计 124/124 通过 六个客户 HTTP 跨进程恢复场景均为 submissions 1 charges 1 原动作结果与客户完成事件各一次 每个恢复场景保留 3 次模拟模型调用及 30 微元 L1 独立账本为 339 次调用 3390 微元 均非真实供应商费用

后续阻塞为 P7 全用途入口治理 包括 legacy API 主模型及政策 scorer 其他付费用途和直接 ChatModel 注入 真实传输价格与版本核验 SDK 重试关闭 取消及 usage 契约 未知费用对账与累计预算恢复 跨进程评测身份恢复 真实模型质量验证仍未实施

真实资金渠道 生产身份 部署和 Docker 未验收 不解锁 P5 不启动真实实验 模拟费用不是供应商实际收费 离线协议通过不等于真实模型质量通过
