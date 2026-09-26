# P7 账本费用归因与只读报告交接

日期：2026-09-26

本轮交付独立费用附加数据，未切换正式报告或评测入口。整个 P7 未完成，不解锁 P5，不启动真实实验。

## 核验事实与文件所有权

Git 仓库实际位于 `D:/project/agent-new/aftersales`，HEAD 为 `38801d92cc3003b8611576dfc0c7cddff15df686`。外层工作区不是 Git 仓库。开始时已有大量已修改和未跟踪文件，全部保留。本轮仅新增以下四个文件：

- `packages/eval/src/p7-cost-report.ts`
- `packages/eval/test/p7-cost-report.test.ts`
- `docs/handoffs/p7-cost-report.md`
- `docs/experiments/p7-cost-report.md`

没有新建专属协议夹具，直接复用只读的 `p7-eval-fixtures.ts` 和 runtime 的 `p7-fixtures.ts`。没有改动公共导出、DTO、美元字段、依赖、原评测工厂、账本、网关、迁移、P6 文件或交接入口。

`p7-integration.md` 中未接入统一迁移的描述属于历史段落；实际 `db.ts` 已调用 `migrateP7`。`P7Ledger.rows()` 实际 SQL 读取完整行，但类型只声明部分金额字段，且没有统一预算读取接口。因此本模块自己执行字段白名单只读查询，不依赖其未声明字段，也不构造会执行迁移的 `P7Ledger`。评测工厂确有严格元组身份，报告和 sim-runner 仍保留美元字段，这与本轮不切换入口的边界一致。

## 输入与输出

唯一执行入口 `readP7CostReport(db, { scope, experimentId? })`，导出结果类型 `P7CostReport`。数据库连接必须由调用方提供，不存在默认 scope 或默认数据库。scope 非空，experimentId 如提供必须非空，字符串原值参与精确比较，不自动 trim 身份。

调用示例可由主任务将来放入正式组合层：

```ts
import { readP7CostReport } from './p7-cost-report.js'

const costAttachment = readP7CostReport(sharedDatabase, {
  scope: 'simulation:first-real-cny-100',
  experimentId: 'exp-1',
})
const costJson = JSON.stringify(costAttachment, null, 2)
```

`sharedDatabase` 是调用方已有连接，不是本模块构造的变量。附加数据应单独保存为 JSON 或由外层 envelope 引用；不要向现有 EvalReport DTO 填充未声明字段，不要写 costUsd。

以下为测试中屏障场景的输出摘录，单位全部为人民币微元，不是供应商真实费用。实验内 settled 十微元与 held 三十微元，共享 scope 另有未归因 unknown 十微元：

```json
{
  "scope": "simulation:first-real-cny-100",
  "currency": "CNY",
  "unit": "micro_yuan",
  "scopeSummary": {
    "attempts": 3,
    "logicalCalls": 3,
    "settled": { "actual": 10, "count": 1 },
    "unknown": { "reserved": 10, "count": 1 },
    "held": { "reserved": 30, "count": 1 },
    "committed": 50,
    "hasUncertainCost": true,
    "active": 1,
    "observation": "recorded_calls"
  },
  "budget": {
    "scope": "simulation:first-real-cny-100",
    "state": "recorded",
    "limit": 100000000,
    "blocked": false,
    "concurrencyLimit": 4,
    "remaining": 99999950
  }
}
```

上例并发上限为既有离线夹具的四个槽位；其余完整输出包括以下字段，不把摘录当完整 DTO：

| 字段                | 口径                                                                 |
| ------------------- | -------------------------------------------------------------------- |
| schemaVersion       | 本附加数据版本 1 不修改权威业务契约                                  |
| observation         | 同一 SELECT 的开始及结束时间 single_statement 与 authorization false |
| scopeSummary        | 当前 scope 全部记录 不受实验筛选影响                                 |
| budget              | 当前 scope 实际预算记录及其完整占用计算出的剩余额度                  |
| selection           | experimentId 为 null 表示全 scope 否则精确筛选 含摘要与 callIds      |
| attributionGroups   | 全 scope 的 eval unattributed anomaly 三组摘要及 callIds             |
| scopeConfigurations | 全 scope 按 snapshotVersion 与 priceVersion 二元组分组               |
| calls               | 全 scope 白名单调用明细 含 attempt 金额 身份及版本                   |

筛选后的 selection 仍保留可解析实验身份但归因异常的记录，必须检查 attribution.kind，不能把其编码 role 当作正常角色。无法识别实验的旧行不会被猜测加入 selection，但始终保留在全 scope 摘要、未归因组与 calls 中。模型配置分组不等于当前实验分组；实验展示需按 selection.callIds 与 calls 关联。

## 金额与调用口径

- 所有金额只读取账本已有的 CNY micro_yuan，不读取价格正文、不重新计价、不转换美元。一元等于一百万微元。
- settled.actual 为已结算实际金额，允许零。unknown.reserved 与 held.reserved 是保守占用，不是已知实际消费。后两种状态的实际金额保持 null。
- committed 等于 settled.actual 加 unknown.reserved 加 held.reserved，与 P7Ledger.totals 一致。每个 attempt 都累计金额。
- attempts 是账本行数；logicalCalls 是当前集合中 operation_id 的去重数，与 scope 内账本唯一约束的逻辑调用语义一致。不能按 operation 去重金额，配置或归因组之间的 logicalCalls 也不应盲目相加。
- active 复用账本规则：held 以及 TIMEOUT CANCELLED CONNECTION 的 unknown 占用槽位，其他 unknown 仍占金额但不占槽位。
- hasUncertainCost 表示观察到 unknown 或 held。空记录时为 false 只代表没有观察到这类记录，不证明整个实验已完成或免费。
- 无预算行时 budget.state 为 uninitialized，limit remaining blocked concurrencyLimit 均为 null。上限从实际记录读取，生产模块没有第二套硬编码上限。
- remaining 可以为负，blocked 独立保留且适用于整个 budget.scope。即使 remaining 为正或 blocked 为 false，也不代表可调用；仍需网关检查价格、权限、并发、预占和其他约束。
- 缺失价格拒绝、调用前取消等可能没有账本行。本报告不能由零行推断成功、免费完成或失败原因。需调用方另外保存运行状态和拒绝证据。
- 损坏的 settled 空金额、非法单位、非法金额或状态直接报错，不静默补零、不修复行。安全整数溢出拒绝出具摘要。

## 严格身份与信息最小化

只接受当前工厂的规范 JSON 编码：`['p7-eval-v1', experimentId, caseId, repeat, role]`。两个 ID 必须非空，repeat 为正安全整数，role 只允许 main_agent simulator judge。原字符串必须等于 JSON.stringify 的规范编码；尾部空白、额外元素或旧身份均不猜测兼容。

operationId 必须是 `[原 runId 字符串, 正安全整数 callRound]` 的规范编码。账本 purpose 与编码 role 不同进入 anomaly/purpose_mismatch；operation 不合法进入 anomaly/invalid_operation；无法识别的 runId 进入 unattributed，并区分旧用途身份与非评测用途。purpose 不一致优先标记，callRound 可同时为 null。

calls 只返回调用标识、purpose、attempt、快照及价格版本、金额、状态和归因结果。不返回请求、完整提示词、对话、usage 正文、价格正文、快照正文或凭据引用。实验身份必须由主任务使用非敏感标识；不能将客户内容编码进身份。scope 全量明细是供内部报告的附加数据，不能直接作为客户页面响应。

## 一致性与只读边界

预算和调用通过同一条 SELECT LEFT JOIN 读取，SQLite 在同一个语句视图内提供一致结果；`.all()` 完成后才在内存计算所有摘要，不二次查询预算或逐条重读费用。记录读取开始和结束时间，观察点位于该区间内；如调用方已经开启读事务，则遵循该事务已有快照，并不保证是墙钟时间的最新提交。

模块不调用迁移、初始化、pragma、BEGIN IMMEDIATE、更新、结算、预占或释放预算，不保持异步长事务。查询执行完即结束自己的读语句；SQLite 的短暂读锁仍遵循调用方连接的日志模式，不能宣称绝对无锁。WAL 可使正常其他连接记账与读取并行，日志模式由已有持久层管理。本轮没有验证跨进程并发恢复，也不主动修改数据库配置。

未迁移的连接缺表时直接抛 SQLite 错误，不自动建表；调用方应呈现读取失败或未准备好，不能降级展示零费用。读取到的是账本观察，不是调用授权凭证，也不证明未经过此账本的付费链路已受控。

## 给主任务的接入清单与接口缺口

1. 主任务统一提供正确的共享数据库连接与明确 scope，不为报告新建库。保持 simulation 和 live 分离。
2. 正式评测装配保存 experimentId caseId repeat、三角色子 runId 与业务 result.runId 关联。费用模块不生成或恢复调用序号。
3. 将此结果作为独立 JSON 附件关联 reportId；现有 report.ts types.ts DTO 及美元字段无需由本模块修改。正式 Markdown 或 UI 渲染接入待主任务完成。
4. 展示当前实验费用时同时展示 scope 累计占用、unknown、held、blocked 和未归因提示，不将剩余额度写成可用授权。
5. 运行完成、阻断原因与未产生账本行的调用需由运行记录补充，现有账本没有这些事实。不得从报告补造成功次数。
6. 如果需要模型名或更多配置元数据，主任务提供最小化且可验证的版本映射；本模块只用快照和价格版本精确隔离，没有读取配置正文。
7. 公共导出、正式报告入口、CLI 与 sim-suite 切换由主任务所有，本轮只相对源码导入。全仓回归由主任务执行。

不支持 unknown 对账、预算授权、跨进程评测恢复、分页或超大账本的流式聚合。当前一次加载选定 scope 的全部白名单行以确保组合结果一致，规模增大时需由主任务评估内存和查询耗时。没有宣称全部付费链路受控。
