# P7 评测预算独立适配交接

任务日期：2026-09-26

本轮仅新增独立模型工厂和离线组合测试。没有切换正式评测入口，没有完成整个 P7，不解锁 P5。P6 售后映射和资金执行权文件未修改。

## 文件清单

- `packages/eval/src/p7-eval-models.ts`：接收共享账本与三个角色配置 返回现有 ChatModel
- `packages/eval/test/p7-eval-budget.test.ts`：真实消费者及预算组合测试
- `packages/eval/test/fixtures/p7-eval-fixtures.ts`：本模块离线传输与屏障 复用既有协议事件夹具
- `docs/handoffs/p7-eval-budget.md`：接口 身份语义与集成清单
- `docs/experiments/p7-eval-budget.md`：实测命令 结果与边界

全部为新增文件。没有新增依赖、公共导出、协议解析器、价格算法、预算表或通用网关。

## 工厂输入

`createP7EvalModels(input)` 的输入如下：

| 字段                  | 约束                                              |
| --------------------- | ------------------------------------------------- |
| identity.experimentId | 调用方提供的非空实验标识 不使用请求内容或客户资料 |
| identity.caseId       | 非空用例标识                                      |
| identity.repeat       | 从一开始的安全整数 表示计划内重复实验轮次         |
| ledger                | 唯一共享 P7Ledger 必须延续先前实验用量            |
| roles.main_agent      | 已校验无密钥 snapshot 与 simulation transport     |
| roles.simulator       | 独立角色 snapshot 与 simulation transport         |
| roles.judge           | 独立角色 snapshot 与 simulation transport         |
| signal                | 可选的本用例取消信号 三类模型均传入原网关         |

网关构造时复核快照哈希。工厂拒绝 live 快照或非 simulation 传输。不得在传输内部访问网络或叠加 SDK 重试；simulation 标签是受信端口契约，不是任意注入代码的网络沙箱。

工厂不新建数据库。不同角色的模型、协议和价格可以不同；已有契约将 budgetRef 固定为 `first-real-cny-100`，本轮限定 simulation，所有角色因此共用同一 `simulation:first-real-cny-100` scope。调用方为不同用例或实验创建新工厂时仍必须传入同一个账本，不能新建三个库。

## 三类消费者示例

以下可放入未来的 `packages/eval/src` 集成文件。传输和快照由调用方提供，示例没有凭据或网络构造。每个用例重复轮次创建一组模型，并在该用例内复用。

```ts
import type { EvalCase } from '../../contracts/src/index.js'
import { createP7EvalModels, type P7EvalModelsInput } from './p7-eval-models.js'
import { runSimCase } from './sim-runner.js'

export async function runBudgetedCase(testCase: EvalCase, input: P7EvalModelsInput) {
  if (testCase.id !== input.identity.caseId) throw new Error('评测身份与用例不匹配')
  const models = createP7EvalModels(input)
  const result = await runSimCase(testCase, {
    agentModel: models.agentModel,
    userModel: models.userModel,
    judgeModel: models.judgeModel,
  })
  return { result, identity: models.identity, modelRunIds: models.runIds }
}
```

`runSimCase` 现有依赖端口可直接接收三类模型：被测模型经过 `TallyingModel` 注入主循环；`userModel` 注入 `UserSimulator`；`judgeModel` 注入 `judgeTranscript`。本轮没有修改或切换这个入口，测试分别真实消费主循环、模拟器和 Judge，没有执行整套正式评测。

直接组合时，`new UserSimulator({ model: models.userModel, scenario })` 的 `openingMessage()` 和 `replyTo(...)` 使用同一个模型连续多轮；`judgeTranscript({ model: models.judgeModel }, rubric, transcript)` 自动记录为 judge。空 rubric 按既有逻辑不发请求。

## 调用身份与费用归因

- 子运行 `runId` 是 JSON 元组 `['p7-eval-v1', experimentId, caseId, repeat, role]` 的编码。它可逆、带命名空间，不依赖有歧义的字符串拼接。账本每个子运行绑定一个快照，解决不同角色快照冲突。
- `operationId` 是 `[子运行标识, callRound]` 的 JSON 编码。`callRound` 在每次调用模型的 `stream` 方法时同步递增，从一开始；同一实例连续两轮不会复用标识，并发调用也不会读到同一个序号。尚未消费的流可留下序号空洞，不代表已付费。
- `attempt` 由 P7Gateway 独占管理，是同一个逻辑调用内供应商尝试次数，从一开始。429 和 5xx 依照快照最多三次，每次预占、传输和入账；工厂没有外层重试。
- `repeat` 表示预先安排的新实验重复轮次，不能拿它包装失败重试。`callRound` 表示消费者发起的新逻辑调用，也不是恢复游标。不能因同一尝试失败而更换实验身份规避去重。
- 同一身份重建模型后计数从一开始，已有 `(scope, operation_id, attempt)` 唯一约束阻断重复传输。工厂不会捕获冲突后随机改号或自动跳到下一轮。同一实验身份必须由单个拥有者持有模型组。
- 计数仅在内存中，不能宣称支持跨进程恢复。调用方需要保存 `identity`、返回的 `runIds` 与业务 `result.runId` 的关联。账本子运行不是业务 runId；正式恢复前必须设计持久调用序号和认领协议，不能读取最大序号后无条件加一。
- `purpose` 分别为 main_agent、simulator、judge。快照版本、价格版本、价格原币与汇率由原账本记录。角色配置在工厂创建后固定，不在一组实例内部切换模型。
- 账本 `actual` 和 `reserved` 单位是 CNY micro_yuan。原 ChatModel 的 `costUsd` 维持 null，现有 sim-runner 的美元费用字段保持 undefined。未做美元转换，不得把人民币微元填入它们。
- 缺失价格在传输前拒绝；缺失 usage 抛错并保留 unknown 预占。超时、取消、连接中断保留未知费用和槽位，可信 usage 已知的截断按实结算。阻断调用没有新增传输或账本行，不代表免费完成。

## 正式入口接入清单及当前绕过点

| 位置                                                 | 核对结果与后续动作                                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `packages/eval/src/sim-suite.ts`                     | buildModel 仍直接创建 AnthropicModel 包括用例级 userModel 覆盖 未来改为接受受信快照集合 传输和共享账本 在用例与重复轮次内调用本工厂 |
| `packages/eval/src/sim-suite.ts` 的 runCaseWithRetry | 仍有用例级瞬态错误重试 正式接入时撤销与网关重复的模型重试 不得通过更换 repeat 重新跑整条业务链                                      |
| `packages/eval/src/sim-cli.ts`                       | 仍进入旧套件路径 需要显式离线装配与实验身份配置 不能因适配测试通过而开启真实实验                                                    |
| `packages/eval/src/cli.ts`                           | L1 真实模式仍创建 AnthropicModel 需要模型工厂注入与共享账本                                                                         |
| `packages/eval/src/sim-runner.ts`                    | 已有三个 ChatModel 依赖端口可复用 尚无实验身份与模型子运行关联的报告输出 需主任务接入取消信号与元数据                               |
| `packages/agent/src/agent.ts`                        | 既有外层重试识别 error.shape P7Error 不带 shape 本轮真实主循环测试确认耗尽网关重试后不叠加重试 未来错误类型转换不能破坏这个边界     |
| `packages/agent/src/anthropic-model.ts`              | 原适配器绕过 P7 直接构造 SDK 本轮未使用 未将它包装成预算传输 SDK 重试需在未来受控传输中关闭                                         |
| `packages/eval/src/report.ts` 与 DTO                 | 仍是原美元费用字段 需新增明确币种与单位的账本归因 未知预占和实耗分开展示                                                            |
| `apps/api/src/main.ts`                               | 仍存在 AnthropicModel 直接构造 属于全用途预算未完成范围 不在本轮修改范围                                                            |
| 各包 index 与依赖边界                                | 当前相对源码导入 保持独立 公共导出与正式依赖变更由主任务统一处理                                                                    |

不能仅导出工厂就宣称上述路径已经受控。任意直接注入裸 ChatModel、每个用途另建数据库或传输自行重试仍可绕过统一累计预算；本工厂不替代正式组合根的强制装配与审计。

## 未完成边界

正式 CLI 和 API 入口切换、全仓回归、跨进程评测恢复、真实网络与供应商验证、费用对账、报告币种迁移、P5 解锁均未完成。全程只使用内存账本和离线事件，未读取 .env 或密钥，未进行真实模型调用、真实资金动作、演示数据库重置或服务启停，也未 build。
