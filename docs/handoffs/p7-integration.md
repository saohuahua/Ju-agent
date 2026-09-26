# P7 模型网关与预算集成交接

日期 2026-09-25

## 主任务集成更新

统一迁移 公开导出与组合根共享账本已接入 详见 [本轮验收](../../../交接备案/12-P6P7模块验收与首段集成.md)
P6 模型适配使用 p6GatewayModel 在固定步骤下按持久认领 attempt 分组 P7 组内尝试仍从 1 开始
恢复保留旧调用费用 同一认领重复调用仍拒绝 已补跨进程联合验证
下文独立模块时期的公共文件状态保留为历史 不代表整个 P7 已完成正式接入

状态：独立模块与零成本协议试验通过，正式付费链路未全部接入，整个 P7 未验收。未 build，未读取密钥，未启动真实调用，实际费用 0 元。测试中的金额均为人工价格下的模拟账本数值。

## 当前接口与职责

| 文件                                         | 职责                                                         |
| -------------------------------------------- | ------------------------------------------------------------ |
| `packages/contracts/src/p7-model-gateway.ts` | 提供商能力 价格 用量 用途 错误及快照契约                     |
| `packages/runtime/src/p7-snapshot.ts`        | 创建与恢复不可变快照 内容 SHA256 人民币微元计费              |
| `packages/runtime/src/p7-protocol.ts`        | Anthropic Messages 与 OpenAI Chat 的请求映射及已解码事件校验 |
| `packages/runtime/src/p7-gateway.ts`         | 超时取消 逐次预占 失败归一 重试及原 ChatModel 接口适配       |
| `packages/persistence/src/p7-migration.ts`   | 独立且幂等的 P7 表与不可变快照更新保护                       |
| `packages/persistence/src/p7-ledger.ts`      | 跨进程立即事务预占 持久费用与并发约束 幂等结算               |

`P7Gateway.invoke` 是主 Agent 子 Agent Embedding 重排 模拟器 Judge 的共同计费入口。operation 必须只执行一次供应商尝试，不得在回调或 SDK 内自动重试；每个重试必须返回网关重新预占。当前仅用于模拟操作，live 模式在调用前抛出 `LIVE_DISABLED`。

`P7Gateway.chatModel(runId, purpose, transport, signal)` 返回现有 `ChatModel`。传输接口只有 simulation 模式，没有 HTTP 客户端、SSE 字节解码、密钥读取或现成真实 SDK 包装。因此不能直接传入现有 `AnthropicModel` 作为已受控传输。

`decodeP7Stream` 保留缺失 usage 为 null。兼容现有不允许未知 usage 的 `ChatModel` 时抛出 `USAGE_MISSING`，不生成零 token 的成功完成事件。用量仍未知时账本保留预占。

## 与 P6 的接口约定

1. 在受理运行时调用 `createP7Snapshot(config)`，将完整返回对象作为 P6 命令或检查点中的 `modelConfigSnapshot` JSON 保存。不是只保存 model 或 version，也不是恢复时重新取全局配置。
2. Worker 读取时调用 `restoreP7Snapshot(savedJsonObject)`，解析严格字段并验证 SHA256。不匹配即拒绝执行，不自动迁移旧快照或填充当前默认值。
3. 对该运行构建 `new P7Gateway(snapshot, sharedLedger)`。在途 Worker、审批恢复、重启恢复均使用同一快照。切换模型只为新运行创建新快照。
4. 将 P6 已有取消信号传入 chatModel 或 invoke。P7 只处理模型调用取消和记账，不创建任务状态、Worker 租约或业务执行意图。取消不能证明远端未计费。
5. `runId` 使用实际运行 ID。`operationId` 可传入 P6 已有稳定步骤 ID，同一 operation 与 attempt 重放会在外部调用前因唯一约束拒绝。它不是业务支付幂等键。
6. 账本在第一次预占时保存并绑定运行快照，同一运行后续替换快照会拒绝。受理时的持久化仍由 P6 所属事务负责；P7 不另建一份命令或检查点。
7. 进程死亡留下 held 费用与并发槽，不按超时自动退还。unknown 的超时 取消 断连也保留槽。应通过未来的供应商对账流程取得计费事实，不能由 Worker 接管直接清零。
8. 当前一个 runId 绑定一个模型快照。不同模型的模拟器 Judge 或未来子 Agent 使用独立子运行 ID，并由调用方保存父运行关联；所有子运行仍必须使用相同累计预算。多模型运行快照集合尚未实现，不要在同一 runId 中静默换模型。

当前源文件尚未从各包 index 导出。协作期的独立测试使用相对源码导入。正式集成后应使用公开包导出，不能假设未声明的包子路径可访问。

## 账本和预算口径

- 固定预算引用 `first-real-cny-100`，数据库上限 100000000 人民币微元，等于人民币 100 元。不是每个模型、用户、运行或日期各 100 元。
- simulation 与 live 的 scope 分开，模拟金额不冒充真实消耗。正式集成必须全进程连接同一持久账本文件，不得为每次调用或每个用途创建内存库。
- 原币单价为微单位每百万 token，加可选每次调用固定微单位费用。账本 actual 与 reserved 统一为人民币微元，currency 固定 CNY，unit 固定 micro_yuan。原币币种、价格版本、来源和汇率有理数保存在 price_json。
- 所有计算用 BigInt 有理数，并在每次调用的合计金额上向上取整到人民币微元。旧 `costUsd` 保持 null；不能把 CNY 微元填入 USD 或旧 cents 字段。
- 价格 null 时不可调用。显式配置的零价和没有配置价格是两种状态。测试价格带 synthetic 来源，不提供默认真实供应商报价或实时汇率。
- 预占采用完整上下文 token 上限加输出上限，宁可多占，不用字符数冒充保守 token 上界。该保证以提供商遵守声明上限及已覆盖的计费维度为前提。
- 立即事务先检查已结算费用加 held 和 unknown 预占，再插入调用。所有用途和重试共同竞争剩余额度。并发上限在同一 scope 中只能收紧，不能靠换快照扩大。
- 成功且用量可信按实结算。协议错误或截断已有可信 usage 时仍计费。缺少用量、未确认失败、进程退出都不当零。429 与 5xx 的未知尝试同样保留预占。
- 仅 429 与 5xx 自动进行有限重试，最多三次，每次独立记账。超时 取消 连接中断不自动重试。当前离线试验没有 Retry-After 和退避调度，真实传输接入前必须补齐。
- 上游报告超出预占的费用时记录全部实耗并熔断后续调用，不截断实际费用假装没有超支。已发生的供应商违规超额无法由本地程序追回，故真实接入前必须核验上下文与计费上界。
- unknown 尚无人工对账接口，默认永久占额。held 可在掌握可信计费事实后结算；不能仅凭租约过期认定免费。finish 是内部受信仓储接口，不可直接暴露给客户端。

## 已接入与待接入

| 链路           | 独立模拟组合根                                 | 正式入口状态与动作                                                    |
| -------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| 主 Agent       | 原 AgentRunner 两轮查单结案通过 两类协议各一例 | `apps/api/src/main.ts` 仍创建 AnthropicModel 需要按运行注入网关       |
| 政策重排       | 原 ChatModelPolicyScorer 调用并入账通过        | compose 中不能继续共用 main_agent 标签的裸 model 需要 rerank 专用句柄 |
| 模拟客户       | 原 UserSimulator 开场调用并入账通过            | `packages/eval/src/sim-suite.ts` 模型工厂仍需改为运行快照与网关       |
| Judge          | 原 judgeTranscript 调用并入账通过              | sim-suite 与 sim-runner 需要独立子运行归因和共享账本                  |
| 子 Agent       | sub_agent 用途通过统一计费入口测试             | P8 尚无正式子 Agent 实现 不宣称接入完成                               |
| Embedding      | embedding 用途通过统一计费入口测试             | P5 尚无真实 Embedding 传输与向量实现 需补批次计费上界和返回契约       |
| L1 评测        | 网关可供注入                                   | `packages/eval/src/cli.ts` 仍创建 AnthropicModel                      |
| SDK 与运行重试 | 网关内重试逐次入账通过                         | 原 Anthropic SDK 默认重试及 AgentRunner 与 sim-suite 重试需要统一治理 |

没有修改原 Anthropic 适配器。其缺失 token 补零、无账本及 SDK 内部重试风险仍存在。不得在正式装配完成前启动原有真实模型 CLI 或据此认为所有付费链路都已受控。

## 公共文件接入清单

本任务未修改下列公共文件。由集成任务统一完成，不能直接照着名单开启真实调用。

| 公共位置                            | 接入动作                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/contracts/src/index.ts`   | 导出 P7Config P7Snapshot P7Price P7Usage P7Purpose P7Capabilities P7Error 及调用身份类型    |
| `packages/persistence/src/index.ts` | 导出 migrateP7 P7Ledger P7LedgerRow                                                         |
| `packages/runtime/src/index.ts`     | 导出快照函数 网关 传输端口及协议适配入口                                                    |
| `packages/runtime/src/compose.ts`   | 提供运行级模型工厂与共享账本 对 Agent 和 rerank 分别归因 不在全局单例闭包捕获某个 runId     |
| `apps/api/src/app.ts`               | 受理时保存完整快照 只接受服务端授权配置 明确返回预算不足与费用未知 不把账本或配置暴露给客户 |
| `packages/persistence/src/db.ts`    | 在统一迁移链调用 migrateP7 独立模块构造目前也会幂等迁移                                     |
| 运行配置与报告 DTO                  | 明确 CNY micro_yuan 价格版本 模拟与真实状态 未知预占与实耗分别显示                          |
| 各包 package.json 与 pnpm-lock.yaml | 本轮无新增依赖 不需要装框架 如后续增加真实传输依赖再集中评审                                |
| IMPLEMENTATION.md 与交接入口        | 集成验证后再记录正式链路状态 不能仅凭本文件标记整个 P7 完成                                 |

同时检查 `apps/api/src/main.ts`、eval cli、sim-cli、sim-suite、sim-runner 的所有构造与重试入口。保留人工审批、P6 Worker 和支付服务的既有所有权。

## 未完成边界

真实网络传输、HTTP 字节 SSE 解码、官方供应商认证与报价核验、缓存与推理等扩展计费维度、Embedding 和独立重排 API 响应适配、真实效果与模型切换回归、预算展示、unknown 对账审计和跨多模型运行快照集合均未完成。

Anthropic 有缓存用量时当前标记费用未知。OpenAI Chat 的普通 prompt 与 completion token 路径已做模拟协议验证，不代表所有兼容代理、Responses API、多模态或推理专用计价均兼容。

完整响应验证后才交付文本和工具事件，因此当前适配器不是实时逐片展示。该选择避免畸形 JSON 和错误工具名先触发业务动作。真实 UI 流式体验可后续增加只读文本旁路，但工具执行仍必须等完整校验。

测试证据与框架取舍见 [P7 模拟实验](../experiments/p7-model-gateway-v1.md)。
