# P6 公共装配与 P7 接口交接

日期：2026-09-25

2026-09-26 更新：本轮审批等待执行权与收货转绑、正式 HTTP 及进程恢复已集成。最新边界与验收以 [本轮交接](p6-p7-entry-integration.md) 为准，下文保留原独立交付清单，不再据此判断当前公共装配状态。

## 主任务集成更新

已增加统一迁移 公开导出 组合根共享句柄及结案与审批状态投影 详见 [本轮验收](../../../交接备案/12-P6P7模块验收与首段集成.md)
模型端口应使用 runtime 的 p6GatewayModel 以稳定步骤加持久认领 attempt 形成调用组
不能将固定步骤 operationId 不经映射重复传入 P7 invoke 否则撞同一尝试唯一约束
下文的公共文件未修改是原交付时状态 当前未完成事项以最新验收为准

## 当前交付边界

新增 P6 专属契约、迁移、仓储、Worker、业务适配器、独立支付模拟器和独立 HTTP 路由工厂。
独立组合根已经用真实进程退出与重启验证恢复。正式 app.ts、compose.ts、各包 index.ts、package.json、锁文件、交接入口与 IMPLEMENTATION.md 均未由本任务修改。

这不是正式产品全链路验收。现有 API 与 AgentRunner 仍使用旧入口，不会因为新增文件自动切换到 P6。接入前必须完成下面的互斥切换与场景回归。

## 需要公共文件所有者接入的项目

| 位置                             | 接入事项                                                   | 必须保持的约束                                                      |
| -------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| persistence index 与数据库初始化 | 导出并调用 migrateP6 导出 P6TaskRepository 与业务适配器    | 老库只新增表 不删除旧数据 不重放历史 running 意图                   |
| contracts index                  | 导出 p6-durable 契约                                       | P6Status 不替换原 RunStatus 或业务状态                              |
| runtime index 与 compose         | 装配 P6Worker 支付客户端 配置映射与业务回写                | 传入同库同步事务回调 禁止异步事务回调                               |
| API app                          | 挂载 createP6DurableApi 或把正式新运行入口改为相同受理事务 | 身份与业务归属先校验 返回 accepted 之前运行命令任务均已提交         |
| API 原审批后台调用               | 移除旧 executeInBackground 对同一意图的 claim 与 resume    | 不让旧引擎与 P6 同时执行一个业务资源                                |
| Worker 生命周期                  | 启动扫描循环 定期调用 bridgeApprovals 与 runOnce           | 使用唯一 owner 一个循环同一时刻只运行一个 runOnce 可启动多个 Worker |
| P3 执行进度读模型                | 关联 p6_tasks 状态 将 needs_confirmation 显式展示为待核验  | intent running 不等于资金还在执行 completed 不等于付款成功          |
| 人工结案                         | 在现有核验上增加未终结 P6 任务与资金意图阻塞               | 即使业务单或关联审计缺失也不能绕过持久任务的待核验状态              |
| SSE 与客户事件                   | 将已确认 P6 事件映射到原白名单事件仓储 同事务追加          | 不公开原始 checkpoint 工具结果 配置或内部异常 不直接输出 p6_events  |
| 测试清库                         | 在旧清库之前按外键顺序删除 P6 子表                         | 只用于显式测试夹具重置 不在正式启动调用                             |
| 包依赖                           | 发布包时补齐显式导出路径和依赖声明                         | 当前独立组合根使用源码相对导入 无新增依赖 无锁文件变更              |

P6 表清理顺序为 p6_events → p6_steps → p6_effects → p6_tasks → p6_commands，然后才是原业务表。生产迁移不能使用清库函数。

## 受理与调用接口

`createP6DurableApi` 暴露独立的 POST /commands、GET /commands/:taskId、POST /commands/:taskId/cancel，以及 GET /commands/:taskId/events。
挂载前注入正式身份解析 customer 与只准备计划的 prepare。演示测试使用测试请求头，正式接入不得照搬该身份替身。

请求携带 Idempotency-Key。原始请求正文与客户及命令类型共同参与判同。同键异参返回冲突。同键同参返回原 taskId、commandId、runId 和原配置，即使全局配置已经切换。
请求键是客户范围内的请求身份；payment.businessKey 是业务动作身份，不能由 runId 或 taskId 生成。

独立 events 端点只投影步骤名称和命令状态，隐藏原始工具结果与内部错误，支持 Last-Event-ID。真实 HTTP 子进程的断连重连已验证。该 task.progress 协议尚未接入正式客户 UI，不等于旧 run 事件通道已完成迁移。

P6TaskRepository.accept 是可信内部接口，不是通用的用户资金请求接口。不能把客户端提供的金额、businessKey、资源编号直接透传为计划。

`P6Worker.runOnce` 原子认领一个任务，自动续约，完成后返回是否认领到任务。进程退出后由下一轮扫描接管过期任务。进程托管和启动脚本由公共装配任务接入，本次没有修改 package.json。

并发限制 global、customer、provider、tool 在 SQLite 写事务内核算；当前 tool 是整个持久计划的工具类别，不是旧 Agent 任意工具调用的全局信号量。
固定执行管线是模型完整结果、只读取证、资金确认。它不是旧 AgentRunner 的任意多轮对话序列化实现。

## 审批交接

审批决定继续由 P3 ApprovalService 与 decidePending 产生。已有 approval_execution_intents 是持久 outbox。
bridgeApprovals 只扫描 pending 意图。映射、消费凭据、业务批准、命令与任务创建、意图转 running 在一个 immediate 事务中提交。任一步失败全部回滚。

p6ApprovalCommand 当前实现补偿和价保的审批映射，核验运行归属、审批决定、资源、金额、最新断点与审批凭据。拒绝决定只创建无资金的后续命令。
价保金额读取 refundAmountCents，补偿读取 amountCents，不能混用。

售后 return_request 审批涉及退款准备、退货收货或换货等待，不可直接套用补偿支付。当前专属适配器会明确拒绝该类型，不自动执行。正式总调度需要为该类型提供保留领域规则的映射器，或只向补偿价保专用扫描器提供对应意图；不能忽略异常后声称审批全覆盖。

历史 running 意图没有可信 P6 所有者或发送标记，不自动迁移。须根据原业务记录和渠道核验决定人工迁移方案。

## 业务服务衔接

本任务没有直接修改既有业务服务。新增 p6-business-adapter 的原因是恢复提交必须把业务结果、幂等记录、审计和检查点放入同一个围栏事务，而原服务各段 await 并不具备该提交边界。

已支持对领域流程准备好的补偿、价保和退款进行发送前复核、executing 标记与确认后的终态回写。退款复核父售后状态、收货条件和政策决策，成功时原子完成父子记录。
不负责重新计算业务资格、创建售后单、仓库收货或生成新的资金计划。未知资金不调用旧业务服务的自动重试分支。

preparePayment、applyPayment 只允许同步使用传入的同一数据库连接。不能复用旧异步服务来绕过事务或围栏。正式启用时必须禁止旧支付执行入口并发处理 P6 已接管的单据。

## 与 P7 的接口约定

1. P7 负责生成和验证 P7Snapshot，包括价格、能力、预算引用、超时和版本；P6 不另建配置系统。
2. p6ConfigFromP7 仅做封装：snapshotId 等于 P7 version，provider、model、promptVersion 用于路由和展示，value 保存完整的无密钥 P7Snapshot。
3. accept 保存快照 JSON；同一个已存在运行的后续命令不得改换快照。历史审批若没有 P6 原始快照，集成人必须显式提供有出处的快照，不能宣称自动还原了历史配置。
4. 恢复时从 task.input.config.value 调用 P7 restoreP7Snapshot，不能读取当前默认模型或预算设置覆盖它。
5. 模型端口收到 input、config、AbortSignal 和 context，context 包含 runId、taskId、operationId、attempt。operationId 固定为 commandId 加 model 步骤标识，P7 仍为每次实际尝试分配独立 callId。
6. P7Gateway.invoke 使用 context.runId、purpose 为 main_agent、operationId 和 signal。usage、预算预占及未知费用归 P7 管理，P6 不把失败成本当零。
7. P6 只提交完整模型结果。流中断重试可以再次调用模型，但 P7 需保留旧调用未知费用。已确认模型检查点不会再调用模型，已发送资金动作优先查询，不能因模型回退而重规划资金路径。
8. P7 的内部重试上限和 P6 任务尝试上限都生效；接入时需计算乘积上限，不能分别设很大而失去整体约束。

已有 P6 快照回环测试使用 P7 实际快照创建与恢复函数。尚未把 P7 网关接到正式 Agent 主循环，本文件是接口约定和装配清单，不冒充另一并行任务已经完成最终集成。

## 接入后仍需补做的验收

- 正式 HTTP 入口受理后真实 API 进程退出和重启
- 现有 AgentRunner 多轮对话与等待客户分支的持久化
- return_request 审批及退货换货等候分支
- P6 事件接入正式页面后的桌面手机交互与原 run 事件游标协同 独立命令 SSE 的真实断连重连已验证
- 人工结案与 P6 needs_confirmation 的联合阻塞验证
- 同一单据的旧新执行入口互斥验证
- 独立 Worker 和支付模拟器的服务托管及 Docker 环境验证

这些边界未完成前，不把本模块实验通过标记为全项目验收完成。
