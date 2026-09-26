# P7 只读费用投影离线组合证据

日期：2026-09-26

## 实验范围

仅执行新增模块定向测试与严格类型、ESLint、Prettier 检查。真实 P7Gateway、P7Ledger、评测工厂、UserSimulator 与 judgeTranscript 在独立内存 SQLite 上运行，协议事件复用既有离线夹具。没有网络、付费模型或真实资金调用。未读取环境秘密、未重置演示库、未启停 8787 或 8790、未 build、未执行全仓回归。

## 验证矩阵

| 场景                 | 实际证据                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 三角色和多个实验身份 | 七次离线传输 七行账本 scope 七十微元 exp-1 六十微元 exp-10 不误匹配 模拟器 callRound 为一和二 用例与 repeat 正确             |
| 429 重试后成功       | 两次传输 两行一个 operation unknown 十微元加 settled 十微元 attempts 二 logicalCalls 一                                      |
| 同视图三状态         | 一次工厂成功 一次直接网关缺 usage 一次屏障内传输 共三行 settled 十 unknown 十 held 三十 实验占四十 scope 占五十              |
| 缺 usage             | 一次传输一行 unknown 十七微元 actual null active 零                                                                          |
| 连接中断             | 一次传输一行 unknown 十七微元 actual null active 一                                                                          |
| 调用中取消           | 屏障保证已经传输一次 一行 unknown 十七微元 active 一                                                                         |
| 超时                 | 屏障保证已经传输一次 一行 unknown 十七微元 active 一                                                                         |
| 缺价格与零价格       | PRICE_MISSING 零传输零行 budget 未初始化 随后显式零价一次传输一行 settled actual 零                                          |
| 快照价格隔离         | 两次调用版本各异 配置组两个 总计三十三微元 live scope 观察零行                                                               |
| 超预占但未超总预算   | 实际费用 200010 微元 不截断 剩余为正且 blocked true                                                                          |
| 旧身份与异常         | 五次直接网关操作五行 总计五十微元 未归因三十 异常二十 正常零 旧 ID 非评测用途 purpose 错配 非法 operation 和非规范编码均保留 |
| 损坏金额             | 测试专用库人工置 settled actual 为 null 报告拒绝出具摘要且不修复                                                             |
| 两次已知用量尝试     | 第一次上游失败也报告 usage 两次直接网关操作两行 settled 二十二微元 logicalCalls 一                                           |
| 缺表                 | 只在独立内存测试库移除 P7 表 调用报缺表 无自动迁移或预算记录                                                                 |
| 超出总预算           | 实际费用 120000010 微元 剩余负 20000010 blocked true 与账本 totals 一致                                                      |

以上十五项测试全部通过。金额为人工模拟价格账本数值，不代表实际供应商花费。直接 invoke 场景的次数是操作回调次数，不冒充 HTTP 网络传输次数。

三状态场景拦截 prepare，验证报告只准备并执行一个 SELECT；读取前后 p7_calls p7_budgets p7_run_snapshots 全行保持一致。多个未知状态场景也分别比较完整账本内容。查询没有写事务、迁移、pragma 或自动释放。此证据是单进程真实 SQLite 组合测试，未执行跨进程并发读写压测。

报告 JSON 可完整序列化，输出不含凭据引用、快照或价格正文、提示词及传输内容。费用读取前后原 ChatModel 完成事件完全一致，costUsd 保持 null。现有 report/types/sim-runner 文件未改动，未新增人民币到美元的映射。

## 实际执行命令

工作目录 `D:/project/agent-new/aftersales`，沿用既有依赖，不安装依赖。以下为最终命令：

```powershell
./node_modules/.bin/vitest.cmd run packages/eval/test/p7-cost-report.test.ts

./node_modules/.bin/tsc.cmd --noEmit --target ES2022 --module ESNext --moduleResolution bundler --lib ES2022 --strict --noUncheckedIndexedAccess --noImplicitOverride --noFallthroughCasesInSwitch --verbatimModuleSyntax --esModuleInterop --skipLibCheck --forceConsistentCasingInFileNames --resolveJsonModule --isolatedModules packages/eval/src/p7-cost-report.ts packages/eval/test/p7-cost-report.test.ts

./node_modules/.bin/eslint.cmd packages/eval/src/p7-cost-report.ts packages/eval/test/p7-cost-report.test.ts

./node_modules/.bin/prettier.cmd --check packages/eval/src/p7-cost-report.ts packages/eval/test/p7-cost-report.test.ts docs/handoffs/p7-cost-report.md docs/experiments/p7-cost-report.md

git -c safe.directory=D:/project/agent-new/aftersales diff --check -- packages/eval/src/p7-cost-report.ts packages/eval/test/p7-cost-report.test.ts docs/handoffs/p7-cost-report.md docs/experiments/p7-cost-report.md
```

类型检查使用与 tsconfig.base.json 一致的严格参数，仅以新增源码及测试为根，依赖类型正常跟随，不执行包级或全仓回归。diff --check 对未跟踪文件不产生内容检查，新增文件格式由 Prettier 和 ESLint 负责。

## 首次失败与修复记录

1. 初次在外层工作区执行 git status 返回不是 Git 仓库，随后切换到指定 aftersales 仓库，只读核验成功。未修改 Git 配置或已有成果。
2. 首轮十二项测试全部通过，首轮定向 TypeScript 与 ESLint 均通过，没有代码断言失败后修改其他模块的情况。
3. 普通权限执行 Prettier --write 时两个新增 TS 文件均返回 EPERM。通过工具的权限审查后仅针对允许范围重新格式化，退出码零。没有绕过权限写入其他路径。
4. 后续补充已知用量重试、缺表无迁移和超总预算测试，十五项全部通过。另完善 LEFT JOIN 空行的可空类型声明，再进行最终定向复验。

最终十五项测试、定向 TypeScript、ESLint、Prettier 检查与范围内 diff --check 均通过，退出码零。正式入口和全仓回归交由主任务，本结果不代表整个 P7 验收。

输入输出示例、金额口径、一致视图设计、接口缺口与主任务接入清单见 [模块交接](../handoffs/p7-cost-report.md)。
