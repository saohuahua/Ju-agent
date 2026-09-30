# P7 模型协议与预算零成本实验

日期：2026-09-25

结论：P7 独立模块 75 条模拟测试通过，协议契约通过不等于真实模型效果通过。正式付费调用链路尚未全部接入，整个 P7 未验收。实际外部调用数 0，实际付费 0 元，未读取密钥，未 build。

## 现状核对

原实现只有 AnthropicModel，直接由 API main、L1 eval CLI、sim-suite 模型工厂创建。ChatModelPolicyScorer、UserSimulator、judgeTranscript 使用注入的 ChatModel。AgentRunner 有轮次重试，sim-suite 有用例重试，SDK 层未显式禁用重试。

原 contracts cost.ts 定义 token 与 cents 视图，但核对到的调用链没有统一价格表、持久预占账本或并发累计预算闸门。AnthropicModel 会将缺失 input_tokens 和 output_tokens 补零，costUsd 返回 null。模拟器 TallyingModel 只累计 token，不能替代预算网关。

运行服务保存 model 和 promptVersion，原配置从构造参数与环境变量获取，没有完整不可变提供商能力、价格、超时、预算快照。此次只读取这些源代码，没有读取环境文件、进程密钥值或秘密存储。

## 方法与取舍

保留现有 ChatModel 和 AgentRunner 循环，新增注入式协议适配。实际试验覆盖两类线协议：Anthropic Messages 事件与 OpenAI Chat chunk。输入为人工构造的已解码提供商事件，不是官方服务连通性验证。

两类协议均让原 AgentRunner 完成查单和结案，并让原政策打分器、用户模拟器和 Judge 经过统一账本。因此当前无需为协议接入强制迁移循环或新增编排框架。

AI SDK Core 仍是候选，未安装、未运行其适配试验，不宣称已采用。后续若比较 SDK，应复用本次坏流和预算测试，并证明能禁用隐藏重试、暴露完整 usage、传播取消和保留原业务控制边界后再决定。LangGraph 等循环迁移不属于本轮。

## 运行证据

工作目录 `D:/project/agent-new/aftersales`

最终测试命令：

```powershell
pnpm exec vitest run packages/runtime/test/p7-protocol.test.ts packages/runtime/test/p7-gateway.test.ts packages/runtime/test/p7-persistence.test.ts packages/runtime/test/p7-consumers.test.ts
```

2026-09-25 22:43:51 本地工具输出摘要：

```text
RUN v3.2.7 D:/project/agent-new/aftersales
p7-protocol.test.ts       32 tests passed
p7-gateway.test.ts        38 tests passed
p7-persistence.test.ts     1 test passed
p7-consumers.test.ts       4 tests passed
Test Files 4 passed (4)
Tests 75 passed (75)
Duration 2.27s
```

以上是已运行输出的整理，不是独立保存的 JSON reporter 原始文件。

| 验证项                             | 证据                                                                |
| ---------------------------------- | ------------------------------------------------------------------- |
| 正常文字 单工具 多工具 参数分片    | 两协议归一为相同 ChatModel 事件 参数重组为对象                      |
| 不完整 JSON 错误工具名 空结果 截断 | 拒绝交付业务工具事件 截断已知用量仍结算                             |
| 重复或不匹配 toolCallId            | 重复输出 ID 未声明分片及历史缺失 重复 错名结果均拒绝                |
| 超时 取消 连接中断                 | 取消信号传播 本地超时能结束 忽略迟到用量 不自动重试未知远端任务     |
| 429 500 503                        | 有限重试 每次尝试单独预占 未知费用累计                              |
| 缺失 usage                         | 协议结果为 null ChatModel 边界抛 USAGE_MISSING 账本保留预占         |
| 价格缺失 真实模式                  | 调用 operation 前拒绝 没有外部调用                                  |
| 币种 单位 价格版本                 | 人民币微元 原币定价版本及汇率 人工有理数舍入测试                    |
| 100 元累计额度                     | 不同用途和模型共享额度 重试不能绕过 多进程只能抢占一次 60 元        |
| 持久化与并发                       | 两个独立 Node 子进程共享磁盘 SQLite 重启保留 held 和并发槽          |
| 快照不可变                         | JSON 往返哈希校验 深冻结 原配置修改不影响旧快照 同运行换配置拒绝    |
| 结算幂等                           | 相同结算重放无重复 修改既有结算拒绝                                 |
| 上游超出预占                       | 记录全部真实值并熔断 不把超额截断为预算值                           |
| 现有循环适配                       | 两协议各完成一次 Agent 查单结案和 rerank simulator judge 消费者试验 |

类型与规范命令均通过：

```powershell
pnpm exec tsc --project packages/runtime/p7-tsconfig.json --noEmit --incremental false
pnpm exec eslint packages/contracts/src/p7-model-gateway.ts packages/persistence/src/p7-*.ts packages/runtime/src/p7-*.ts packages/runtime/test/p7-*.ts
```

首次测试 60 条通过后发现新增测试中的 TypeScript 类型标注问题，已修正。一次 runtime 全包类型检查同时遇到正在并行修改的 P6 fixture 中 final 对象缺少 escalated，本任务未改 P6 文件；随后新增专属 P7 类型检查配置并通过。未宣称全仓类型或全量测试已验收。

## 修改文件清单

全部为 P7 专属新增文件，没有覆盖旧文件或提交 Git。

```text
packages/contracts/src/p7-model-gateway.ts
packages/persistence/src/p7-migration.ts
packages/persistence/src/p7-ledger.ts
packages/runtime/src/p7-snapshot.ts
packages/runtime/src/p7-protocol.ts
packages/runtime/src/p7-gateway.ts
packages/runtime/p7-tsconfig.json
packages/runtime/test/p7-fixtures.ts
packages/runtime/test/p7-budget-child.ts
packages/runtime/test/p7-protocol.test.ts
packages/runtime/test/p7-gateway.test.ts
packages/runtime/test/p7-persistence.test.ts
packages/runtime/test/p7-consumers.test.ts
docs/handoffs/p7-integration.md
docs/experiments/p7-model-gateway-v1.md
```

## 解释边界

并发证据使用两个独立进程和同一 SQLite 文件，不是生产分布式数据库或压力测试。预占正确性依赖所有调用统一入口、同一持久预算库和已核验的供应商计费上界；旧直连路径仍未替换。

真实模型的工具选择、参数语义、拒绝与升级、回答质量、延迟、缓存计费及提供商兼容性均未测。未知用量的永久占额是保守默认，尚无人工对账 UI 或安全释放流程。

正式接入清单、P6 快照接口和未完成边界见 [P7 集成交接](../handoffs/p7-integration.md)。
