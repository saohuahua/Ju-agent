# P6 持久任务与恢复实验记录

日期：2026-09-25

## 结论与范围

P6 独立模块已实现持久受理、请求判同、原子认领、租约与所有者代次、受控取消、审批意图桥接、检查点续跑、独立持久支付模拟渠道和故障证据保存。

本次 P6 专项共 42 条测试通过，其中 18 个独立进程及支付渠道场景，加 1 个真实 HTTP 子进程 SSE 断连重连场景。其余 23 条验证仓储、业务事务、请求入口和 P7 快照接口。

正式 API 主入口与旧 AgentRunner 未切换。当前范围是独立模块与测试组合根，不能写成全项目 P6 已集成验收或生产可用。

## 基线与约束

- 工作目录 D:/project/agent-new/aftersales
- 分支 codex/youju-upgrade
- HEAD 38801d92cc3003b8611576dfc0c7cddff15df686
- HEAD 之外存在大量未提交的 P3 P4 和并行 P7 成果 本次全部保留
- 已核对 P4 知识实现与冻结实验报告 审批执行进度契约仓储与界面均在当前工作树
- 未修改公共装配文件或已有业务服务 未 build 未提交 Git
- 支付只有本机 HTTP 模拟器 模型只有脚本模型 实际付费模型和真实支付调用均为零

## 原始证据入口

| 材料                     | 路径                                                               | 可证明的内容                                                           |
| ------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 18 场景清单与源码 SHA256 | [manifest.json](p6-results/2026-09-25T14-52-15.247Z/manifest.json) | 执行环境 场景通过状态 子进程退出结果 实验时源码版本                    |
| 自动生成的逐场景数据表   | [analysis.md](p6-results/2026-09-25T14-52-15.247Z/analysis.md)     | 任务代次 业务状态 支付发送成功与查询次数 模型次数                      |
| 进程日志与业务渠道数据库 | [进程实验目录](p6-results/2026-09-25T14-52-15.247Z/)               | 每个场景都有 process.log application.db channel.db terminal-state.json |
| SSE 原始连接数据         | [SSE 实验目录](p6-sse-results/2026-09-25T14-58-16.950Z/)           | 第一条连接和重新连接内容 持久事件与命令终态                            |
| 全仓回归原始输出         | [p6-validation.log](p6-validation.log)                             | 当时工作树 406 条全仓测试通过 含 P7 并行测试                           |
| 公共接入与边界           | [p6-integration.md](../handoffs/p6-integration.md)                 | 尚需接入的公共文件与 P7 参数约定                                       |
| 学习和简历事实           | [p6-learning-evidence.md](p6-learning-evidence.md)                 | 问题分析 工程取舍 可讲述事实与不能声称的内容                           |

可下载 [完整证据包](p6-evidence-2026-09-25.zip)，内含最终引用的日志、数据库、P6 源码、测试和说明文档。

原仓库忽略所有 .db 文件。数据库仍保存在上述本地目录，另将最终引用的 36 个进程实验数据库与 1 个 SSE 数据库打包进证据包，便于随 Git 外的交接或下载保存；未改变原有 .gitignore。

较早的 14:38 与 14:49 UTC 实验目录保留为中间记录。本报告默认引用 14:52 UTC 的 18 场景运行；SSE 在后续独立补充验证，不把它拼成同一次 19 场景运行。

## 设计与关键不变量

### 持久受理

运行、命令、任务在同一 SQLite immediate 事务内写入，提交后才返回 accepted。客户与请求键组成唯一约束，原始请求不一致返回冲突。
配置切换不改变重试受理结果。同一个运行的后续命令不得改换已持久化快照。

HTTP 工厂只接收可信 prepare 产出的计划，金额与资源不能直接从客户端透传。请求幂等与支付幂等是不同边界：前者保护重复点击或网络重试，后者保护同一业务动作跨新运行编号的重复执行。

### Worker 围栏

认领与四类并发配额检查在同一个写事务内执行。每次接管增加 generation，租约续期、释放、检查点和终态写回都检查 owner、generation、leaseUntil 与 running 状态。
旧 Worker 迟到不能写回；外部渠道不受本地 SQLite 锁控制，因此仍需独立的业务幂等键。

### 审批意图

P3 已有的决定与执行意图事务继续作为可靠入口。P6 扫描 pending 意图，将映射、授权消费、命令创建及意图占用放在同一事务中。
进程在审批决定之后退出时，下一进程仍能找到 pending 意图。映射或入队失败时授权消费随事务回滚。

当前内置审批映射覆盖补偿和价保；售后审批的退货换货与收货前置不能复用该映射，仍待专用接入。历史 running 意图没有 P6 代次，不自动接管。

### 检查点与资金状态

模型完整结果和只读取证分别保存检查点，模型流中断不写已完成事件。资金先写发送意图，再调用渠道。渠道确认后，本地业务单、幂等结果、审计与支付检查点在一个围栏事务内提交。

已存在资金意图的恢复优先查询，跳过模型和只读前置步骤。即使查询返回 not_found，也不重发，因为本地无法据此证明没有在途请求。

| 任务状态           | 含义                           | 自动动作                    |
| ------------------ | ------------------------------ | --------------------------- |
| queued             | 已持久受理或等待有界重试       | 可认领                      |
| running            | Worker 正持有有效租约          | 续约并继续未完成步骤        |
| completed          | 本命令流程完成                 | 不再执行                    |
| call_failed        | 调用失败且达到尝试或时间上限   | 不自动无限重试              |
| business_failed    | 渠道返回明确拒绝               | 不把拒绝当网络超时          |
| needs_confirmation | 已发送或可能已发送但终态未确认 | 不自动认领 受控恢复也只查询 |
| cancelled          | 已按策略停止后续工作           | 已发生资金事实仍保留        |

任务 cancelled 与业务 succeeded 可以同时成立，表示取消发生在资金动作之后，系统确认了资金事实并停止后续工作，不表示撤销已付款项。

## 完整计划第 8 节故障矩阵对照

| 故障点                 | 实验方式                                                      | 实际观察                                                 | 证据场景                                          |
| ---------------------- | ------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| 受理后 Worker 未开始   | 受理子进程 exit 73 新 Worker 进程启动                         | 原任务完成 单次渠道发送                                  | accepted-before-worker                            |
| 模型调用前退出         | Worker 在命名边界 exit 73 租约到期后新进程接管                | generation 增至 2 原 snapshotId 保持                     | before-model                                      |
| 模型流中途断开         | 脚本流产出文本后立即退出整个进程                              | 首次没有模型检查点 恢复后模型调用累计 2 次 资金仍 1 次   | mid-stream                                        |
| 只读工具超时           | 两个独立 Worker 进程分别遇到超时                              | 第二次达到上限 call_failed 模型只调用 1 次 无资金发送    | read-timeout                                      |
| 支付成功但响应丢失     | 独立渠道提交后销毁 socket                                     | 原键查询一次后确认成功 没有第二次 POST                   | channel-response_lost                             |
| 副作用成功但本地未记账 | 收到支付响应后 Worker 直接退出                                | 新进程查询同一交易 业务单与本地记录补齐                  | after-payment-response                            |
| 检查点写入后退出       | 分别在模型与支付检查点后退出                                  | 已确认模型或资金步骤不再执行                             | after-model-checkpoint / after-payment-checkpoint |
| 审批通过后尚未调度     | 真实 ApprovalService 决定后进程退出                           | 意图仍 pending 下一进程桥接并完成                        | approval-accepted-exit                            |
| 双 Worker 同时认领     | 两个进程等待启动屏障后同时竞争                                | 仅一方 claimed 为 true generation 为 1 仅 1 个渠道动作   | two-workers                                       |
| 过期旧 Worker 返回     | 旧进程保留代次 新进程接管完成后通知旧进程返回                 | 旧写入被拒绝 续约 false 没有 stale-write 检查点          | stale-worker-return                               |
| 用户取消长任务         | 独立进程只读阻塞期间写入取消请求                              | 心跳传递取消信号 无资金发送                              | cancel-long-task                                  |
| SSE 断网后重连         | 真实 HTTP 子进程 第一条连接主动 abort 再用 Last-Event-ID 连接 | 首次序号 1 重连收到 2 和 3 不重复模型步骤 无原始结果泄漏 | 独立 SSE 实验目录                                 |

其他场景覆盖渠道明确拒绝、结果未知、延迟响应、资金成功后取消、发送意图落库但尚未发送时退出，以及渠道自身退出重启并以新 runId 执行同一业务键。

单进程单测另行覆盖受理事务回滚、四维并发限制、旧代次所有写入口、业务记账回滚、原始请求冲突、客户归属、审批授权与 P7 快照回环。它们不计作跨进程实验。

## 代表性数据与解释

1. 响应丢失：任务 completed、补偿 succeeded、渠道 POST 1 次、成功动作 1 次、查询 1 次。说明调用失败并不等于资金失败。
2. 本地未记账：新 Worker generation 为 2，渠道 POST 仍为 1，查询 1 次后本地提交。说明检查点本身不足以关闭外部副作用空窗，必须查询渠道事实。
3. 结果未知：受控查询后仍是 needs_confirmation，渠道 POST 保持 1。不会生成新键或自动重发。
4. 发送前崩溃：渠道 POST 为 0，恢复查不到交易后仍保持 needs_confirmation。这是有意保守的策略，会牺牲自动恢复率，换取不在缺少证明时重放资金动作。
5. 新运行编号：数据库出现 2 个任务与 2 个 runId，但只有 1 条幂等结果、1 次渠道 POST、1 个成功动作。资金身份独立于运行身份。
6. 中途模型退出：模型日志次数为 2，资金发送次数为 1。允许重取未确认模型输出，不允许把前面的已确认业务动作一起重做。

这些是构造故障下的观测值，不是生产重复退款率、吞吐、P95 延迟或准确率指标。

## 实际验证清单

全仓 pnpm test 的当次记录为 406 条：Web 28、contracts 15、domain 92、persistence 31、tools 18、workflow 10、agent 22、runtime 106、eval 17、API 67。runtime 中 P7 的 75 条为并行任务成果，不记入 P6 独立贡献。

其后新增 P6 SSE 真实网络实验。P6 HTTP、P6 SSE、既有 SSE 定向回归 6 条通过，其中新增 1 条，其余为复跑。累计当前已验证测试为 407 条，不声称这些在同一次全量命令中执行。

P6 独立新增分布：runtime 31、persistence 9、API 2，共 42 条。全仓禁用增量缓存的类型检查通过；新增 SSE 后 API 类型检查再次通过。P6 全部新增源码的定向 ESLint、格式化与 git diff --check 通过。

曾遇到的实现及环境问题：

- 沙箱拒绝创建实验目录，使用工具审批后执行本地实验，没有改用内存库规避跨进程验证
- 首次脚本模型夹具缺少 escalated 字段，补齐后类型检查通过
- 复核发现价保断点使用 refundAmountCents，修正映射并增加补偿价保真实审批事务测试
- SSE 新增测试初次类型检查提示子进程输出管道可能为空，改为可空访问

## 复现方法

在项目根目录执行，不需要 build、真实模型密钥或真实支付配置。

```powershell
pnpm --filter @aftersales/runtime exec vitest run test/p6-durable.test.ts test/p6-process.test.ts test/p6-snapshot.test.ts
pnpm --filter @aftersales/persistence exec vitest run test/p6-business.test.ts
pnpm --filter @aftersales/api exec vitest run test/p6-durable-api.test.ts test/p6-sse-reconnect.test.ts
pnpm exec tsx scripts/p6-evidence-report.ts docs/experiments/p6-results/2026-09-25T14-52-15.247Z
```

每次进程实验创建新的时间戳目录，不覆盖旧证据。测试会启动并关闭自己创建的子进程，不终止其他服务，不修改原演示数据库。真实 HTTP 监听只绑定 127.0.0.1，支付客户端禁止访问其他主机与重定向。

## 修改文件清单

所有下列代码文件均为新增。没有修改既有业务服务、模型适配器、费用账本或知识检索文件。

| 分层                 | 文件                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约                 | packages/contracts/src/p6-durable.ts                                                                                                               |
| 专属迁移             | packages/persistence/src/p6-migration.ts                                                                                                           |
| 命令任务与围栏仓储   | packages/persistence/src/p6-task-repository.ts                                                                                                     |
| 业务适配             | packages/persistence/src/p6-business-adapter.ts                                                                                                    |
| 独立渠道与客户端     | packages/persistence/src/p6-payment-simulator.ts                                                                                                   |
| Worker               | packages/runtime/src/p6-worker.ts                                                                                                                  |
| P7 快照封装          | packages/runtime/src/p6-config-snapshot.ts                                                                                                         |
| HTTP 与 SSE          | apps/api/src/p6-durable-api.ts / apps/api/src/p6-event-stream.ts                                                                                   |
| 仓储与 Worker 测试   | packages/runtime/test/p6-durable.test.ts                                                                                                           |
| 进程故障矩阵与组合根 | packages/runtime/test/p6-process.test.ts / packages/runtime/test/fixtures/p6-process.ts                                                            |
| P7 接口回环          | packages/runtime/test/p6-snapshot.test.ts                                                                                                          |
| 业务事务测试         | packages/persistence/test/p6-business.test.ts                                                                                                      |
| HTTP 测试            | apps/api/test/p6-durable-api.test.ts                                                                                                               |
| 网络重连测试与组合根 | apps/api/test/p6-sse-reconnect.test.ts / apps/api/test/fixtures/p6-sse-process.ts                                                                  |
| 证据汇总脚本         | scripts/p6-evidence-report.ts                                                                                                                      |
| 阶段与学习文档       | docs/experiments/p6-recovery.md / docs/experiments/p6-learning-evidence.md                                                                         |
| 公共接入清单         | docs/handoffs/p6-integration.md                                                                                                                    |
| 原始产物             | docs/experiments/p6-results/ / docs/experiments/p6-sse-results/ / docs/experiments/p6-validation.log / docs/experiments/p6-evidence-2026-09-25.zip |

## 尚未完成的边界

公共文件接入、旧 Agent 多轮运行与等待分支、售后审批退货换货映射、旧新资金入口互斥、正式工作台进度与结案联合核验、生产身份、容器托管和真实渠道均未在本任务验收。
SQLite 在本地单机多进程下验证过，不代表多机分布式锁或数据库网络分区已验证。当前每类进程故障执行一轮确定性场景，没有做统计显著性、压测或随机调度探索。

后续应按公共接入清单关闭这些边界，再把当前实验脚本用于正式路径回归。不要把独立模块测试通过改写为全项目验收完成。
