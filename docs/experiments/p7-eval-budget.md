# P7 评测预算离线组合证据

任务日期：2026-09-26

## 既有覆盖与新增目的

已读 `packages/runtime/test/p7-consumers.test.ts`：两类协议分别覆盖主 Agent 查单后结案两轮，以及 rerank、真实 UserSimulator 单次开场和 judgeTranscript 单次判定共享账本。它没有验证模拟器同一实例连续两轮、跨用途耗尽预算、不同角色快照身份及本轮工厂。本轮未修改或重复运行该文件。

新增测试使用真实 P7Gateway、P7Ledger、UserSimulator、judgeTranscript 和主 AgentRunner。每个测试新建独立内存 SQLite 库，afterEach 关闭。传输只回放既有协议事件或人工注入错误，不访问网络。主 Agent 只查询内存订单并结案，不执行支付。

## 最终证据矩阵

| 场景                                               | 实际传输与账本证据                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| 真实模拟器两轮 被测模型一轮 Judge 一轮             | 传输分别为 2 1 1 共四行 结算四十微元 Judge 返回真实失败判据 purpose 为 judge      |
| 真实主 Agent 查单结案                              | 两次传输 两行 main_agent 记录 运行结果 completed                                  |
| 先前主模型消费六十元 后续模拟器与 Judge 各需六十元 | 主模型一次 模拟器零次 Judge 零次 账本仅一行 六十元                                |
| 模拟器和 Judge 各消费四十元后再调用主模型          | 前两者各一次 主模型零次 共两行 八十元                                             |
| 不同实验 用例和重复轮次                            | 四次传输 四个子运行 四行记录 只有一个 budget scope                                |
| 同一身份重建模型                                   | 重放被唯一约束拒绝 累计仍一次传输一行记录                                         |
| 并发六十元预占                                     | 首调用被屏障保持 held 后续用途被拒绝 后续传输零次 全程一行 最终结算六十元         |
| 取消与超时                                         | 各一次传输一行 unknown actual 为 null 六十元预占与一个槽位保留 网关信号到达传输   |
| 调用前已取消                                       | 零传输 零账本行                                                                   |
| 缺失 usage 与流中断                                | 各一次传输一行 unknown 后续六十元调用零传输 流中断额外保留并发槽                  |
| 已有可信 usage 的截断                              | 一次传输一行 settled 六十元实际费用 仍阻断后续六十元调用                          |
| 429 与 503 后成功                                  | 各两次传输两行 同 operation 的 attempt 分别为一和二 第一行 unknown 第二行 settled |
| 首次失败已占六十元 随后网关重试预算不足            | 仅一次实际传输一行 unknown 后续尝试无传输                                         |
| 连续限流耗尽三次后重建同身份                       | 累计三次传输三行 unknown 重建不增加传输                                           |
| 真实主循环面对网关两次限流耗尽                     | 两次传输两行记录 结果 failed 外层没有扩为更多尝试                                 |
| 缺失价格                                           | PRICE_MISSING 零传输 零行 不产生免费完成事件                                      |
| 非法身份 篡改快照 live 配置                        | 构造拒绝 零传输零行                                                               |

金额都是人工固定单价的模拟账本值，不是实际供应商费用。实际付费模型与真实资金调用次数均为零。不同角色分别使用不同模型与价格版本，模拟器使用 Anthropic Messages，主模型和 Judge 使用 OpenAI Chat；快照版本和传输 body.model 均有断言，美元 costUsd 为 null。

## 定向验证命令

工作目录 `D:/project/agent-new/aftersales`。使用现有依赖，没有安装或修改包文件。

```powershell
./node_modules/.bin/vitest.cmd run packages/eval/test/p7-eval-budget.test.ts

./node_modules/.bin/tsc.cmd --noEmit --target ES2022 --module ESNext --moduleResolution bundler --lib ES2022 --strict --noUncheckedIndexedAccess --noImplicitOverride --noFallthroughCasesInSwitch --verbatimModuleSyntax --esModuleInterop --skipLibCheck --forceConsistentCasingInFileNames --resolveJsonModule --isolatedModules packages/eval/src/p7-eval-models.ts packages/eval/test/p7-eval-budget.test.ts packages/eval/test/fixtures/p7-eval-fixtures.ts

./node_modules/.bin/eslint.cmd packages/eval/src/p7-eval-models.ts packages/eval/test/p7-eval-budget.test.ts packages/eval/test/fixtures/p7-eval-fixtures.ts

./node_modules/.bin/prettier.cmd --check packages/eval/src/p7-eval-models.ts packages/eval/test/p7-eval-budget.test.ts packages/eval/test/fixtures/p7-eval-fixtures.ts docs/handoffs/p7-eval-budget.md docs/experiments/p7-eval-budget.md

git diff --check
```

类型检查显式复用 tsconfig.base.json 的严格选项，只指定新增源码与测试作为根文件；依赖类型按 TypeScript 正常规则跟随，不执行全仓包级类型检查。git diff --check 不覆盖未跟踪新增文件，新文件由 Prettier 与 ESLint 校验。

首轮十七条测试通过；类型检查发现测试查询结果为 unknown，补充查询边界类型后通过。随后补充真实主循环和失败耗尽保护证据。最初普通权限格式化两个测试文件返回 EPERM，工具获准后定向格式化成功，没有以写失败冒充格式化通过。

最终结果见本文件验收记录。没有执行全仓回归，没有启动 CLI、付费模型、真实支付或服务，没有 build。

## 验收记录

最终定向测试一文件二十条全部通过，退出码零。定向 TypeScript 与 ESLint 均退出码零。最终类型复验曾误写一个编译选项导致 TS5023，按上方准确命令修正重跑通过。Prettier 检查和 git diff --check 均通过。

结论仅为本轮独立适配及离线组合测试通过，不以此替代全 P7 验收。全仓回归由主任务执行。

## 限制

并发证据是同进程异步并发下共享真实 SQLite 预占，不是跨进程恢复测试。内存序号不能用于恢复，unknown 没有自动对账。三类真实消费者分别组合验证，不代表现有 sim-suite 正式入口已经迁移或整套付费链路已接通。交接与后续接入见 `docs/handoffs/p7-eval-budget.md`。
