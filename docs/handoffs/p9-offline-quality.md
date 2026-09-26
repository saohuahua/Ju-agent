# P9 离线质量与可观测闭环

后续独立验收发现的三项遗漏已修复 最终全仓 673/673 类型 ESLint 通过 正式离线 L1 正常 248/248 故障 124/248 见 [修复交接](p9-fixes.md) 原交付记录保留如下

## 编码前能力与缺口矩阵

| 能力 | 已实现及依据 | 本轮补强 | 本轮不做 |
| --- | --- | --- | --- |
| 重复实验 | p7-suite-entry 与 sim-suite 已逐轮执行 复用 experimentId caseId repeat | 保留全部轮次 门禁检查所有轮次 固定样本禁止混算 | 真实随机稳定性结论 |
| 指标报告 | metrics 与 report 已有分层指标 Pass@k Pass^k 和失败摘要 | 修正首轮限定和条件分母 自述版本及分母 | 评测网页 |
| Judge | judge 与 sim-runner 已接主观判据 | 完整唯一判据 严格输出 超时拒绝 业务成功独立统计 | 真实人工校准 |
| 失败导出 | sim-runner 已导出场景及 transcript | 包括服务失败 原始业务记录和模型请求响应定位 过滤令牌 | 生产日志平台 |
| 费用身份 | P7 已有元组身份 只读成本报告 与 eval_budget_evidence 保存 | 关联原角色 run call attempt 保留 unknown held 和无记录 | 新账本 自动清理未知费用 |
| 持久证据 | P6 有 commands tasks effects events P8 已有报告和原文关联 | 本轮 L1 L2 legacy 路径不存在的持久标识明确为空 | 重做持久调度器 |
| 可复核配置 | 已有 promptVersion 和 P7 快照版本 | 数据集与顺序 快照 政策知识 受控源码清单及脏树标记 | 凭据和无关目录收集 |
| 对比 | 已有 P8 专用串并行报告 | 通用稳定 case repeat 对齐 可比性拒绝及故障变化 | 不同样本合并提升 |

初始实际工作树仅 IMPLEMENTATION.md 已修改及 human-return-fix.md 未跟踪 与早期交接的大量未提交描述不同 以本轮 initial-worktree.txt 为准 保留原内容

## 本轮结果

2026-09-26 P9 离线最小闭环完成 全仓 665/665 非增量类型 ESLint 和 git diff --check 通过 正式 L1 单独统计 124 个固定用例两轮各 124/124 合计 248/248 受控故障实验第一轮 124/124 第二轮 0/124 如实失败

初始 HEAD 实际为 5b6275a4a5c4609618fda62f3119430ef2e2b234 不是旧交接中的初始升级提交 本轮未提交或推送 Git 没有覆盖已有 IMPLEMENTATION 与 human-return-fix 内容

| 本轮验收能力 | 结果 | 边界 |
| --- | --- | --- |
| 数据配置身份 | 已实现 | 全集哈希 选中用例快照及顺序 重复轮次 政策版本 基础知识与夹具哈希 角色快照 原始提示词请求 受控源码清单 |
| 脏树来源 | 已实现 | dirty 为 true 清单记录内容 SHA256 不把 HEAD 当完整可复现证明 不归档源码正文或环境文件 |
| 逐轮报告 | 已实现 | 所有轮次保存且门禁检查全部轮次 样本缺失重复乱序拒绝构建 不自动合并不同样本 |
| 原始证据与失败导出 | 已实现 | 业务库关闭前读取断言对应行 业务事件和工具执行 模型接口请求与输出 保存逐用例 JSON 并核验关联 |
| 失败分类与分母 | 已实现 | 七类可同时发生 所有计划内服务失败取消保留分母 主观 Judge 与确定性业务分开 |
| P7 费用 | 已复用 | 不改账本算法 单位 CNY micro_yuan settled unknown held 分开 无记录不等于零成本 |
| 报告比较 | 已实现 | 稳定 case repeat 对齐 可比性拒绝 新增修复持续失败 保留两份独立分母 |
| Judge 防误判 | 已实现 | 非法条目 空数组 缺判据 重复判据 未完成输出 超时均不通过 不用正则挽救非法 JSON |
| 校准准备 | 已实现准备格式和算法 | 真实人工标注与真实 Judge 输出均没有 仍为尚未校准 |
| P8 持久调查质量 | 本轮不扩展 | 原 P8 专用报告继续保留 tasks steps events conclusion 与业务来源 P9 不把 legacy CLI 伪装为 P8 持久实验 |
| 真实模型与部署 | 本轮不做 | P5 锁定 不调用真实模型 Embedding 支付 不进入 P10 P11 |

## 修改文件

| 文件 | 修改 |
| --- | --- |
| packages/contracts/src/eval.ts | 兼容可选 metricVersion metricDenominators repeat |
| packages/eval/src/types.ts | 内部原始业务证据类型 |
| packages/eval/src/runner.ts | L1 关闭业务库前捕获实际证据 |
| packages/eval/src/sim-runner.ts | L2 捕获证据 所有失败路径导出 主观失败与业务结果分离 |
| packages/eval/src/judge.ts | 完整唯一判据 严格 JSON 完成标记及超时 |
| packages/eval/src/metrics.ts | 工具及升级指标不再按通过标记筛选分母 业务成功独立于 Judge 显式分母 |
| packages/eval/src/report.ts | 全部轮次 明细 repeat 严格同构样本 门禁覆盖所有轮次 零样本指标不输出数值 |
| packages/eval/src/p7-suite-entry.ts | 原套件装配异常收口 配置与模型请求输出记录 原身份及费用附件扩展 |
| packages/eval/src/sim-suite.ts | 复用原套件封装和元数据 保留取消后的计划内失败 |
| packages/eval/src/p7-cli.ts | 原正式入口归档质量包 受控第二轮协议故障 任意失败返回非零 |
| packages/eval/src/p9-metadata.ts | 内容哈希 数据和配置来源 受控源码清单 |
| packages/eval/src/p9-evidence.ts | 断言记录和事件读取 敏感字段及文本回显过滤 |
| packages/eval/src/p9-report.ts | 逐用例归档 校验 分类 分母 比较 |
| packages/eval/src/p9-cli.ts | 只读 verify 与 compare 命令 |
| packages/eval/src/p9-calibration.ts | 带版本人工标注格式和合成算法校验 |
| packages/eval/test/p9-judge.test.ts | 9 项 Judge 故障与正常协议 |
| packages/eval/test/p9-quality.test.ts | 16 项元数据 证据 对比 故障 费用 校准准备与业务边界 |
| apps/web/src/lib/types.ts 与 apps/web/src/app/eval/page.tsx | 旧消费者兼容可选 repeat 失败列表以 case repeat 为键和展开身份 显示评测轮次 不新增评测网页功能 |
| packages/eval/test/p7-entry.test.ts | 原取消测试改为检查失败分母与零账本行 保留零传输要求 |
| docs/handoffs/p9-offline-quality.md 与 docs/experiments/p9-offline-quality.md | 本轮交接与实测 |
| docs/experiments/p9-offline-quality-evidence | 首次失败 完整报告 逐用例证据 对比 日志和复核 |
| IMPLEMENTATION.md 与 ../交接备案/00-新对话入口.md | 前置最新状态 保留历史记录 |

原回归自行产生的 P6 P7 P8 API 证据目录保留 不属于修改旧业务实现 未修改 P7 网关账本费用报告 持久层字段或 API 业务路由 前端仅修正多轮失败列表的类型 键和展开状态 未接入 P9 网页功能

## 报告字段与兼容策略

EvalReport 新增可选 metricVersion 为 p9-v1 metricDenominators 为各指标分母 caseResults.repeat 为一开始的轮次 旧 JSON 不要求这些字段并通过原 Zod 契约 新报告 total passed failed byCategory caseResults 覆盖全部轮次 而旧报告仍是历史首轮口径 不拿旧报告直接计算 P9 差值

业务 task_success_rate 忽略 judge 失败 但综合 passed 和端到端指标要求全部通过 业务指标仍以确定性数据库与工具断言为准 Judge 不改变资金权限规则 零样本的分类指标从新 report.metrics 省略 对应分母仍保留为 0 不能按缺省值解释为通过

原 eval_reports.report_json 与 eval_budget_evidence.evidence_json 直接保存兼容扩展 没有新表和迁移 evidence.metadata 包含数据快照和源码清单 evidence.cases 增加 business modelCalls configurations 旧 P7 附件仍能读取 旧附件缺元数据只能展示 不能宣称可公平比较

每个报告目录含 quality.json quality.md failures.json 与 cases/序号.json 原 CLI 的 reportId.json reportId.evidence.json reportId.md 继续输出 failures.json 是带哈希的失败定位索引 不复制一份不受校验的文本

metadata.datasetHash 为加载后全集内容哈希 selectedHash 为脱敏后的选中用例快照哈希 caseOrder 与 repeat 固定顺序 基础 knowledgeHash 和 fixtureHash 配合每条 selectedCases.fixturePatch 描述实际输入 source 记录 HEAD dirty 及 packages apps scripts 的代码配置清单 根依赖锁和工具配置也计入 排除隐藏目录 node_modules dist coverage data 文档归档与环境文件

角色配置保存受信 P7 快照并过滤 credentialRef 等敏感字段 快照原 version 是网关已经验证的身份 不能对脱敏快照重算并冒称原完整快照 提示词版本来自快照 实际动态 system messages tools 原文位于 modelCalls.request 模型输出是 ChatModel 接口实际事件 包括原文本和工具参数 不是供应商原始网络字节 本轮没有真实供应商传输

## 身份与原始证据关联

| 起点 | 关联 | 实际定位 |
| --- | --- | --- |
| quality.json | experimentId report.reportId metadata | 原 eval_reports 与 eval_budget_evidence 已保存相同报告 |
| references.key | JSON 元组 caseId repeat | references.file 对应 cases 文件 contentHash 与 references.hash 相等 |
| cases.identity | 原 experimentId caseId repeat | 不另建预算身份 不用 repeat 代替失败重试 |
| cases.businessRunId | business.runId runs.run_id events.run_id | 同次独立业务库中的真实运行及事件 |
| business.assertions | assertion 与 rows | 逐条确定性状态断言实际查询结果 保留空行事实 |
| business.executions gatewayCharges | 工具执行及模拟资金成功计数 | 与原断言同一个独立业务系统 |
| modelRunIds | 原 p7-eval-v1 元组及角色 | 工厂创建的角色身份 未调用的角色没有账本行 不宣称发生调用 |
| modelCalls.runId callRound | costs.calls.runId attribution.callRound | 原 operationId 为角色 runId 与 callRound 元组 |
| costs.calls | callId operationId attempt snapshotVersion priceVersion | 原 P7 只读报告的逐尝试记录 金额不按逻辑调用去重 |
| 模型工具调用 | modelCalls.events.toolCallId 与 business.events 的 payload | legacy tool_executions 无独立 toolCallId 列 不补造联结字段 |
| commandId taskId | 本轮 legacy 路径均为 null | absenceReason 明确未创建持久命令和任务 服务装配失败的 businessRunId 和 business 也为空 |

校验器实际读取文件 检查内容哈希 用例集合与顺序 轮次 判定及分母 业务 run 事件唯一性 断言证据完整性 角色元组与调用唯一性 账本与模型观察双向关联 成功调用无费用证据拒绝 失败调用没有账本行是允许的真实拒绝事实

结构化字段 token one_time_token credentialRef authorization cookie secret password apiKey 及相应嵌套 JSON 和已知值的文本回显过滤 使用模拟数据不等于可以导出内部令牌 本轮证据不是面向客户的公开 API

## 比较与费用口径

比较先验证两份本地证据包 再检查层级 全集及样本哈希 顺序 轮次 政策知识 夹具 指标版本 受控源码哈希 角色运行配置与币种单位 model prompt 可声明为变量 fault 用于明确受控故障实验 源码发生变化仍保守拒绝 比较不自动跳过不同用例或合并分母

本轮正常对故障 新增失败 124 修复失败 0 持续失败 0 只发生在第二轮 不声明 fault 时返回不可比 differences=null CLI 退出码 2

正常实验 settled 6780 微元 678 次调用 故障实验 settled 3390 微元 unknown.reserved 1240 微元 共 463 次调用 最终两实验合计 committed 11410 微元 1141 次调用 原共享 scope 包含之前验收两实验累计 committed 22820 微元 2282 次调用 held 为 0 模拟已结算差值 -3390 微元只描述已观察结算差异 实际总费用差值为 null 因故障实验有未知费用 不称为节省成本

qualitySummary.endToEnd 包含所有计划内轮次 business 同时保留总分母和 scorable 可评分分母 主观项只统计实际调用 Judge 的轮次 七类失败允许重叠 故障报告有 121 个业务断言失败 124 个模型协议失败和 3 个伴随服务异常 所以类别数量不能相加成失败用例数

## 验收与首次失败

完整命令和链接见 [实验记录](../experiments/p9-offline-quality.md)

- Judge 首次最小回归 7 失败 1 通过 复现空数组 缺失 重复和非法 JSON 被误判通过 修复严格解析及完整判据检查 没有弱化业务断言
- 首次类型检查发现归档返回类型与校验器循环推断 改为显式 QualityBundle 接口
- 定向 ESLint 首次发现 inline import type 规则错误 改为顶层 type import
- 最后检查旧消费者发现失败列表只以 caseId 作为键 多轮重复项存在冲突 补齐 repeat 类型 键 展开状态及轮次标签 随后重跑最终全仓及两组 L1 原先日志和账本均保留 不重置费用
- 最终 P9 25/25 全仓 665/665 全仓非增量类型及 ESLint 通过 正式 L1 另计正常 248/248 故障 124/248 且预期退出 1
- 归档复核读取 496 个实际证据文件 与原临时 SQLite 持久附件逐项相等 费用选择与原账本一致 integrity_check 为 ok 两份报告源码哈希一致且 dirty=true

## 剩余边界与后续条件

Judge 为 not_calibrated 没有真实人工标签或真实 Judge 输出 calibration-preparation.json 的 0.5 仅是两个明确合成标签的算法自检 不能作为 Judge 一致率 模型可靠性或质量提升结论 空真实标签集合一致率为 null

离线多轮只证明确定性机制稳定 不证明真实模型随机稳定性 不提供跨进程评测续跑 不自动对账未知费用 不迁移所有资金场景 P8 真实多 Agent 效果仍未验证

进入 P10 可以另立离线 Compose 与部署任务 需确认目标 Docker 环境 可持久化目录 初始化不覆盖数据 重启任务账本保持 默认本机暴露 无 Docker 时只能交付静态检查不能宣称启动通过

真实模型传输准备必须另立任务 明确供应商模型版本 已核实单价币种汇率 usage 完整性 取消超时语义 SDK 内部重试关闭 P7 唯一入口与累计 100 元预算授权 先处理未知费用及对账策略 再申请受控真实调用 不能通过新 experimentId 或 repeat 重置预算 P5 继续锁定

本轮未 build 未读 .env 或真实密钥 未操作演示库 未启停既有 8787 8790 未调用外部模型 Embedding 或真实资金 未进入部署或完整学习文档

提交归档说明 完整 JSON 原始包保留本地且已加入忽略规则 仓库保存精简验收摘要与关键日志 重复中间实验包已清理 详见 docs/experiments/p9-validation-summary.md
