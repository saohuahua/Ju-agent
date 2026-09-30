# P8 最小离线调查交接

日期 2026-09-26

后续集成验收发现的未知资金与受理重放缺陷已修复 全仓 640/640 类型 ESLint 通过 正式离线 L1 另计 124/124 见 [修复交接](p8-fixes.md) 下文为初始交付记录

## 编码前设计

场景为客户未收货诉求的仅退款调查 订单履约记录与承运记录可能矛盾 政策版本和适用条件需独立核对 不是拆分一次查单

单 Agent 基线串行执行事实调查和政策调查 多分支模式并行执行相同调查 两者使用完全相同的冻结订单物流政策原文 相同只读能力和结果校验 同样两个确定性离线分析调用 基线使用主运行身份 main_agent 多分支使用独立子运行身份 sub_agent 不宣称脚本具备真实推理能力

事实读取与政策读取可并行 汇总必须串行等待所有分支终态 本轮不做上下文裁剪 原始证据完整持久化 运行便签只引用事实 不改写事实 客户陈述单独保存且不是权限或签收证明

现有 P6 claim 排除同一 runId 的并行任务 P6 Worker 只有 conversation 特殊管线和固定模型读取资金管线 因此最小扩展是可选的具名任务处理器 继续由 P6Worker 执行认领续租取消超时围栏 专属父子关联表只保存关联及冻结输入 不另建状态机或调度器

父任务和两个子任务在同一事务受理 子任务使用独立运行身份 父子关系显式落表 内部命令键使用独立命名空间 不占用客户请求键 不滥用 approvalId 或 businessKey 原始客户请求键只用于父任务幂等

P6 任务拥有执行状态 检查点拥有已确认调查结果 父任务检查点拥有唯一汇总 分支终态和就绪通知同事务提交 父任务只有收到就绪凭据才可认领 重复通知由原事件唯一键消重 父取消同事务传播给两个子任务 写回同时校验自身围栏和父任务未结束 迟到响应不得修改已确认结果

所有模型调用使用 P7Gateway 和同一个 P7Ledger 用途已有 main_agent sub_agent 足够 不修改 P7 协议账本或评测身份 逻辑调用身份由持久任务和固定分析步骤编码 网关独占 attempt 不因 Worker 重启更换逻辑身份 未确认模型调用若已入账则保守停止并保留未知费用 不自动重发 已确认分支完全跳过

每个结果保存父运行 子任务 子运行 客户订单 状态 事实 原文引用 未决问题 错误 配置和知识版本 分支失败或超时仍保留另一侧事实 但不输出可办理建议 关键证据缺失补问 证据冲突和调用失败升级人工 不用空结果填成功

运行记忆保存客户订单关联 客户陈述 分支状态 已确认事实与原文指针 未决问题 等待原因 原审批业务动作及未知结果 原业务引用从持久原记录读取 不接受客户声明作为授权 不引入跨客户记忆或向量库

业务建议仅为取证后交由现有受控入口进一步核验 不执行审批退款补偿价保或业务状态迁移 分支没有资金端口 主流程也不装配资金能力 本轮没有第二个业务写入者 不变更正式客户路由与默认模式

独立实验使用临时数据库 真正子进程退出重启检查任务 检查点 原文 账本 结果事件 两种模式的时间仅为本机受控延迟观测 不能推断真实质量成本延迟 本任务只做定向验收 全仓回归及 L1 留给两任务冻结后的集成者

## 文件所有权

仅新增 P8 专属契约 持久关联 运行时 实验夹具测试及本任务文档 必要公共修改限 packages/runtime/src/p6-worker.ts 的可选处理器 不改公共导出 组合根和全局迁移 不改任务 B 的网页客户 DTO 或 API 路由

## 实施结果与接口

本轮完成最小离线取证及建议闭环 不连接客户默认流程 不包含真实模型质量实验 场景中的确定性条件本身无需模型 两次脚本调用专门验证角色协议 身份预算及证据流 不能据此论证生产中必须使用多 Agent

入口为 `packages/eval/src/p8-offline-cli.ts` 只创建新的系统临时库 不接受演示库路径 参数是证据输出目录 示例

```powershell
pnpm --config.verify-deps-before-run=false exec tsx packages/eval/src/p8-offline-cli.ts docs/experiments/p8-offline-investigation-evidence/new-comparison
```

源码调用链

`P8Investigation.capture` → 原 SqliteOrderRepository SqliteShipmentRepository SqlitePolicyArticleRepository → 冻结原文及知识哈希 → `accept` 同库事务验证源记录及业务引用 → 原 P6TaskRepository.accept 受理父和两子任务 → `run` 按冻结模式驱动原 P6Worker → 专属 handler → 原文检查点 → P7Gateway.chatModel → 结构化字段与引用核验 → 分支确认与就绪事件 → 父 handler → 原 decidePolicy → 唯一建议检查点

可调用接口为 `capture(customerId, orderNo, policyVersion?)` `accept(input)` `run(parentTaskId, phase?)` `repo.cancel(parentTaskId, customerId)` `repo.memory(parentTaskId)` `repo.result(childTaskId)` 以及 `p8Report(runtime, parentTaskId)` 它们是可信后端组合接口 不是认证后的 HTTP 接口 接入前仍需原身份认证层 不能直接将任意客户提交的 P8Input 当可信配置

`capture` 是准备数据 `accept` 在一个同步立即事务内再次比较源记录和版本 再原子受理 数据准备后源事实变化会明确拒绝 不使用异步长事务 `run` 是有界驱动一次 遇其他 Worker 持有租约或配额不足时可能仍有 queued/running 调用者读取原任务状态后继续驱动 不增加后台扫描器

正常每个调查阶段一次离线模型协议调用 汇总及记忆没有模型调用 串行基线两个阶段共用父运行模型身份 main_agent 并行两个调查角色使用各自子运行身份 sub_agent 两种模式的子任务都存在用于等价持久确认 串行基线不是两个并行 Agent 也不额外共享答案 两边模型输入是相同分工下的相同原文和客户陈述

## 身份 状态与事务边界

| 对象 | 身份与状态所有者 |
| --- | --- |
| 对照轮次 | experimentId caseId repeat mode 在受理输入中冻结 repeat 为计划重复轮次 本轮全部为 1 |
| 父运行 | 原 P6 accept 创建 parent runId 与 parent taskId 元数据 source 为 sim |
| 子任务 | 两个独立 runId taskId commandId 在 p8_branches 按父 taskId 和 role 唯一关联 |
| 内部命令键 | JSON 元组 p8-parent-v1 或 p8-child-v1 不接受客户请求键充当分支身份 |
| 模型逻辑调用 | JSON 元组 p8-call-v1 childTaskId analysis 重启不换号 |
| 网关尝试 | P7 独占 attempt 原 scope operation_id attempt 唯一约束不改 |
| 运行状态 | p6_tasks 及原租约围栏 agent_runs 仅提供关联元数据 P8 不投影到正式客户状态 |
| 原始证据 | p8_investigations.input_json 完整冻结来源 分支 p6_steps 的 p8-evidence 为模型调用前确认副本 |
| 调查结果 | p6_steps 的 p8-result 及 step:p8-result 事件 同事务写原任务终态 |
| 父汇总 | p8-ready:父taskId 只作为原认领事件过滤条件 p8-conclusion 与任务完成同围栏事务写入 |

父子受理失败全部回滚 每个处理器的 acceptedEvent 绑定具体父任务 防止处理另一实验任务 子任务确认同时检查自身租约代次 父任务终态与取消状态 引用归属 原文字段和配置版本 失败结果不能夹带成功事实 重复完全相同结果只返回 false 不产生第二条结果 结果冲突明确拒绝

父取消同事务设置父子原任务 cancel_requested Worker 续租时传播 AbortSignal 取消或执行失败发生于 handler 之前时 不伪造 p8-result 而由 `repo.result` 从原任务终态投影完整身份及错误 时间设 null 不编造执行时间 父流程已结束时迟到结果不落确认检查点

## 预算 快照与恢复

同一 P8Investigation 的父子始终共用原数据库 P7Ledger 没有新增预算表或预算字段 独立 CLI 的四组八个运行也共用一个库和一个 simulation:first-real-cny-100 scope 最终 16 条 settled 调用 人工计价 160 人民币微元

本轮所有角色选用相同受信快照 不实现角色分别切换配置 接受后的全部快照存入原命令 恢复只还原原快照 当前 options 仅提供受信离线 transport 构造器 P7 继续验证哈希 mode 和 purpose 不修改 LIVE_DISABLED 不增加 SDK 或 Worker 模型重试

网关可依原快照最多尝试三次 错误返回后分支确认失败不触发 Worker 再重试 模型已入账但没有确认分支结果的崩溃空窗保守升级人工 不重新调用 不自动对账 不回收 held 或 unknown 正常已确认分支重启完全跳过 本轮三个要求的退出窗口外额外验证了此空窗

simulation 是受信端口约定 并不是任意传输代码的网络沙箱 本轮实际传输实现仅使用本地原生事件及 setTimeout 没有访问真实模型 通用报告保留 realProviderCost 为 not_measured 不从 simulation 标签推导供应商免费

## 运行记忆的真实范围

单次父运行内确定性投影 保存客户订单 客户原话 原始证据引用 两侧确认事实 未决问题 等待或失败原因 分支终态 原退款售后补偿价保及相关审批引用 已完成及未知业务动作

业务引用来自当前客户订单的原表 不是用户输入客户自称主管不改变审批 pending 原业务 unknown processing sending 等状态保留在 unknownActions 不会转为成功 内存对象修改不影响受理快照 记忆采用受理时业务事实 不声称持续同步后续业务变化 不执行压缩或长期向量记忆

模型只返回被原文逐项核验的字段和引用 其输出不能覆盖原始证据 缺物流或丢件政策原文产生 ask_user 订单签收与物流丢件矛盾 模型引用冲突 部分调用失败 或原业务未知产生 human_review 另一侧已确认事实仍保留 controlled_review 仅表示可以交现有领域受控入口进一步处理 不是批准或退款成功

## 修改文件清单

| 文件 | 作用 |
| --- | --- |
| packages/contracts/src/p8-investigation.ts | 专属结果原文记忆及协议 Schema |
| packages/persistence/src/p8-investigation-repository.ts | 专属关联表 受理 确认 取消 原任务投影 |
| packages/runtime/src/p6-worker.ts | 唯一既有源码扩展 新增可选具名 handler 继续使用原认领续租超时围栏 |
| packages/runtime/src/p8-investigation.ts | 源记录捕获与事务核验 有界调查及原领域规则建议 |
| packages/runtime/test/p8-investigation.test.ts | 23 项机制安全矩阵 逐例原文协议与库归档 |
| packages/runtime/test/p8-process.test.ts | 4 项真实子进程退出重启矩阵 |
| packages/runtime/test/fixtures/p8-process.ts | 独立故障退出进程 |
| packages/eval/src/p8-offline-fixture.ts | 确定性离线协议 人工价格 故障与输入配置 |
| packages/eval/src/p8-offline-report.ts | P8 关联只读报告 不改 P7 费用报告 |
| packages/eval/src/p8-offline-cli.ts | 独立四组同数据串并行对照入口 |
| docs/handoffs/p8-offline-investigation.md | 本交接 |
| docs/experiments/p8-offline-investigation.md 及专属证据目录 | 实测命令 完整状态 失败修复与对照结果 |

未修改公共导出 compose 全局迁移 客户 DTO apps/web 正式 API 路由 领域资金规则 P7 网关账本及正式评测工厂 专属关联表只在显式构造 P8 时创建 P6 原回归自行生成的证据保留在其原实验目录 不是修改旧实现

## 已验证与集成清单

最终 P8 27/27 通过 其中机制矩阵 23 项 真实进程 4 项 四个相关包类型检查和本任务 ESLint 通过 早一轮包含 26 个 P8 和 73 个原 P6/P7 用例的定向回归 99/99 通过 最后新增事实确认防线后单独重验 P8 不把两次运行分母相加 详见 [实验记录](../experiments/p8-offline-investigation.md)

四组同数据对照均建议兼容 调用均为 2 次 20 人民币微元 串行在途峰值 1 并行 2 均为本机受控协议机制 不代表真实模型质量 成本下降或生产延迟改善

给最终集成者

1. 本任务文件已完成定向验收 任务 B 文件未改 不需要客户 DTO 接口变更
2. 保留 P6WorkPorts.handlers 的可选性质 不将 P8 加入 compose 或客户默认模型模式
3. 显式运行 P8 必须提供受信快照 原身份层验证后的客户订单 同一个共享库 仅授权只读传输
4. 任务 A B 完成并冻结后执行全仓测试 类型 ESLint 及正式离线 L1 L1 分母单独记录 本轮未执行最终全仓或重跑 L1
5. 统一集成后才更新共享交接入口与 IMPLEMENTATION 本任务没有修改它们 建议状态文字为 P8 有限双分支调查及运行记忆离线机制完成 真实质量实验未开始 客户默认流程保持原模式 P5 继续锁定
6. 后续生产化需另立设计 包括真实模型证据解释质量 角色上下文策略 异步只读源的一致性 业务快照刷新 在途费用人工或自动对账 以及正式入口认证和状态投影 本轮不预先开启

初始工作树见 ../experiments/p8-offline-investigation-evidence/initial-worktree.txt 全部既有未提交成果保留 未 build 未读 .env 或真实密钥 未操作演示库 未启停 8787/8790 未调用真实资金或模型 未提交或推送 Git
