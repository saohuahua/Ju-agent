# P8 有限双分支与运行记忆离线实验

日期 2026-09-26

后续集成验收及缺陷修复已完成 全仓 640/640 类型 ESLint 通过 正式离线 L1 另计 124/124 见 [修复实测](p8-fixes.md) 下文为初始实验记录

## 结果口径

最终 P8 **27/27** 通过 23 项机制测试加 4 项真实子进程实验 四个相关后端包类型检查及本任务文件 ESLint 通过 本轮不执行最终全仓回归 不重跑正式 L1 先前 L1 124/124 仅是交接历史 不能当成本轮结果

此前定向回归 **99/99** 包含当时 P8 26 项和直接依赖 P6/P7 73 项 后续仅 P8 补强确认事实与归档并重验 27 项 不把两次测试结果相加为一个新全量分母

执行模型均为确定性本地原生协议事件 未调用真实模型或真实资金 没有业务写入通道 人工价格为每调用 10 人民币微元 usage 为人工 10 输入和 5 输出 token 不是供应商实际价格或真实模型成本

## 独立对照

入口 `packages/eval/src/p8-offline-cli.ts` 每次新建系统临时 SQLite 库 保存副本到指定输出目录 原业务数据取项目已有夹具 只改变目标订单的已标明固定场景 两种模式同原文 同政策版本及知识哈希 同只读能力 同字段引用校验 同 decidePolicy 规则

单 Agent 基线两阶段串行同父模型身份 main_agent 多分支模式两调查角色并行并以 sub_agent 归因 汇总使用确定性领域规则 所有真实协议调用仍经过 P7Gateway 两种模式均为两次调用 原文读取和运行便签没有模型调用

本表来自 [最终报告](p8-offline-investigation-evidence/comparison-verified/report.json) 每个调用人为等待 50ms 是**受控延迟实验** 每组只测一次 repeat=1 不表示真实供应商性能或稳定统计优势

| 固定场景 | 两模式共同建议 | 串行端到端 ms | 并行端到端 ms | 串行调查关键路径 ms | 并行调查关键路径 ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 物流确认丢件且记录一致 | 交原受控入口进一步核验 | 141 | 76 | 125 | 67 |
| 仍在运输而未确认丢件 | 补问承运商认定 | 136 | 76 | 127 | 66 |
| 订单已签收但物流显示丢件 | 人工核验证据冲突 | 135 | 81 | 125 | 72 |
| 缺少丢件政策原文 | 补齐关键政策证据 | 128 | 77 | 117 | 67 |

每行两模式均调用 2 次 均 settled 20 人民币微元 未知及 held 均为 0 全部八个运行共用同一账本 累计 16 次调用 160 人民币微元 不为分支新建预算 四组证据集合一致 政策版本一致 最终建议兼容

端到端从受理输入记录的 acceptedAt 到父结论确认前的 finishedAt 调查关键路径为串行两调查已记录时长之和 或并行最大调查时长 不包含受理排队和汇总开销 不冒充完整供应商链路延迟 补充测试直接验证在途调用峰值串行 1 并行 2 不仅依赖耗时推断

`taskCompleted` 仅说明父任务已给出结果 `investigationComplete` 才表示具备受控核验建议所需证据 缺证和冲突用例诚实保留 unresolved 对照报告不包含推理评分 不据此声称多 Agent 质量更好或成本下降 通用报告 realProviderCost 为 not_measured 本轮实际未发起任何真实模型请求

## 验收矩阵与证据

最终机制矩阵目录 [matrix-2026-09-26T05-16-29.930Z](p8-offline-investigation-evidence/matrix-2026-09-26T05-16-29.930Z) 每个子目录保存独立 application.db 和 evidence.json JSON 含测试名 原始协议请求响应帧 父子任务 快照 原文 检查点 结果事件及共享账本 部分单独构造的错误传输只由账本与错误结果记录 不将不存在的响应帧补造成成功协议

| 要求 | 实测断言 |
| --- | --- |
| 正常双分支 | 两角色 confirmed 父 controlled_review 引用均指向本次原文 两条 sub_agent 调用 |
| 单多兼容 | 同原始证据和政策哈希 同事实及建议 单模式两调用归属同父 runId |
| 明确分支失败 | 另一侧确认事实保留 父 human_review 未决问题非空 不伪装完整 |
| 分支超时与迟到 | timeout 原 unknown 预占保留 迟到后原结论和账本不变 |
| 缺关键物流或政策 | ask_user unresolved 明确保留 不填空成功 |
| 源冲突与模型冲突 | 订单签收和丢件矛盾升级人工 模型字段异于原文拒绝确认 |
| 父取消 | 客户归属校验 在途信号传播 父子 cancelled 不落迟到确认 不消除未知费用 |
| 重复受理派发完成 | 原任务复用 同时驱动不增调用 唯一汇总事件 重复结果拒绝覆写 |
| 跨客户跨订单引用 | 原读取端口拒绝越权 wrapper 和原文引用核验 重新计算哈希也不能伪造源记录 |
| 共享预算不足 | 原 scope 已持有 99999995 微元 两分支在实际传输前 BUDGET_EXCEEDED 原预占不减少 |
| 未知费用 | 缺 usage 及 timeout 均保留 actual=null reserved=10 不当零 另一分支同账本可见 |
| 恢复复用 | 已确认 p8-result 不重做 配置及原文不随内存对象变化 |
| 旧 Worker 围栏 | 新认领 generation 增加 旧 claim 无法写检查点 |
| 资金能力 | 下发工具目录为空 execute_refund 工具意图被 P7 拒绝 六张业务资金表运行前后逐行一致 |
| 原业务未知 | 原退款 unknown 和审批 pending 原样保留 客户自称主管不授予权限 |
| 受理原子性 | 子任务插入触发故障时父与子受理全部回滚 |
| 运行间隔离 | 指定父运行的驱动不能认领另一实验的队列任务 |
| 尝试上限 | 三次 UPSTREAM attempt 同一 operation Worker attempt=1 无叠加调用 人工总占用40微元 |
| 失败不能夹带事实 | 持久确认接口拒绝 failed 结果携带成功事实 memory.confirmedFacts 仍为空 |

## 真实进程退出恢复

最终目录 [process-2026-09-26T05-16-29.930Z](p8-offline-investigation-evidence/process-2026-09-26T05-16-29.930Z) 每例独立系统临时数据库 首进程 process.exit(71) 真正退出 再启动新的 Node 进程 恢复不注入提前编造的分支结果

| 退出位置 | 退出时断言 | 恢复后断言 |
| --- | --- | --- |
| accepted | 父及两子已受理 三任务 零结果 零调用 | 两条 settled 20微元 两结果一汇总 原业务表不变 |
| one-confirmed | 事实分支已确认 一调用 政策未完成 | 原事实结果精确不变 最终两调用 无额外重复 |
| both-confirmed | 两分支已确认 两调用 父未汇总 | 仅补唯一父结论 原任务标识快照原文不变 |
| model-unconfirmed | 原文已确认 一模型调用已结算 分支结果未确认 | 不重发原调用 人工核验建议 政策调用一次 最终总两调用 |

前三例再次启动第三进程 验证完整报告保持一致 所有场景联合检查 p6_tasks p6_steps p6_events p8_investigations p8_branches p7_calls 原业务表及最终数据库副本 不仅验证输出文本

模型未确认窗口本例使用已结算离线响应 不能声称验证了真实供应商未结算费用自动对账 held 或 unknown 的保守处理由既有 P7 与本轮超时缺 usage 场景覆盖 本轮没有新增自动对账

## 首次失败与修复

1. 初始沙箱拒绝项目证据目录写入 经工具权限升级后成功保存初始工作树 无删除或覆盖旧成果
2. [首次类型检查](p8-offline-investigation-evidence/typecheck-first.log) 两项失败 runtime 包不直接依赖 zod Clock 还要求 advanceTo 将 Schema 放入已有 Zod 的 contracts 并按原接口提供不可变时钟 没有新增依赖
3. [首次测试](p8-offline-investigation-evidence/tests-first.log) 17 项中 7 项失败 均因错误地断言已有夹具退款表为空 改为六张业务及资金表前后完整记录相等 保留历史业务事实 没有删除夹具或放松业务写入断言
4. [首次规范检查](p8-offline-investigation-evidence/lint-first.log) 一处仅类型使用的 import 未写 import type 已修复
5. 复核增加具体父任务认领过滤 原文对源记录核验 失败结果禁止夹带事实 未确认费用保守恢复 和终态无结果投影 相关新增断言最终通过 所有中间日志与早期报告保留

## 最终命令和日志

以下命令在项目根目录执行 不执行 build 不访问真实模型 不读取 .env

```powershell
pnpm --config.verify-deps-before-run=false --filter @aftersales/runtime exec vitest run test/p8-investigation.test.ts test/p8-process.test.ts
pnpm --config.verify-deps-before-run=false --filter @aftersales/runtime exec vitest run test/p8-investigation.test.ts test/p8-process.test.ts test/p6-durable.test.ts test/p6-process.test.ts test/p6-p7-integration.test.ts test/p7-gateway.test.ts test/p7-persistence.test.ts
pnpm --config.verify-deps-before-run=false --filter @aftersales/runtime --filter @aftersales/persistence --filter @aftersales/contracts --filter @aftersales/eval exec tsc --noEmit --incremental false
pnpm --config.verify-deps-before-run=false exec tsx packages/eval/src/p8-offline-cli.ts docs/experiments/p8-offline-investigation-evidence/new-comparison
```

本轮 ESLint 只列交接清单中的十个源码测试文件运行 不使用全仓 --fix 或批量格式化

- [最终 P8 27 项日志](p8-offline-investigation-evidence/p8-verified.log)
- [先前 99 项直接依赖定向回归](p8-offline-investigation-evidence/directed-final.log)
- [最终四包类型检查](p8-offline-investigation-evidence/typecheck-closed.log)
- [最终定向 ESLint](p8-offline-investigation-evidence/lint-closed.log)
- [最终对照控制台输出](p8-offline-investigation-evidence/comparison-verified.log)
- [最终对照完整报告](p8-offline-investigation-evidence/comparison-verified/report.json)
- [初始工作树](p8-offline-investigation-evidence/initial-worktree.txt)
- [最终工作树](p8-offline-investigation-evidence/final-worktree.txt)
- [归档复核及文件哈希](p8-offline-investigation-evidence/final-summary.json)

交付前只读复核 30 份归档数据库 包括机制矩阵 25 个独立库 进程恢复 4 个独立库和对照 1 个共享库 SQLite integrity_check 均为 ok 并重新比较父子任务 原始受理输入及逐尝试账本与 JSON 报告 对照库确认只有一个预算 scope 累计 16 次调用 160 人民币微元

## 交付边界

仅任务 A 后端实验完成 本任务没有改 apps/web 客户 DTO 正式路由 公共导出 组合根 领域退款审批 P7 账本字段费用报告及现有正式评测身份 没有引入编排框架 Redis 向量库或第二套任务调度器

未默认启用多 Agent 未解锁 P5 未启动真实模型实验 未迁移新资金业务 未操作演示数据库 未启停既有 8787/8790 未提交或推送 Git 全仓回归与 L1 必须在任务 A B 完成并冻结后统一执行
