# P9 离线质量实测

后续三项验收遗漏已修复 最终结果及新增回归见 [P9 修复实测](p9-fixes.md) 下文保留原交付实验记录

日期 2026-09-26 所有命令在 aftersales 项目根执行 使用已有依赖 没有 build

## 结果

全仓单次最终回归 **665/665** 退出码 0 分包 Web 32 contracts 15 domain 92 persistence 103 tools 18 workflow 10 agent 22 runtime 155 eval 85 API 133 不与 P9 定向 25 或正式数据集重复相加

[全仓测试](p9-offline-quality-evidence/full-tests-final.log) [非增量类型](p9-offline-quality-evidence/full-typecheck-final.log) [ESLint](p9-offline-quality-evidence/full-lint-final.log)

正式 L1 124 个唯一用例 两轮正常均为 124/124 总计 **248/248** 受控第二轮协议故障保持同样数据与顺序 第一轮 124/124 第二轮 0/124 总计 **124/248** 预期退出码 1 故障报告未改判

| 运行 | 证据 | 结果 |
| --- | --- | --- |
| 正常两轮 | 质量报告（本地文件 `p9-offline-quality-evidence/normal-final/evr_392b54bc/quality.md`） JSON（本地文件 `p9-offline-quality-evidence/normal-final/evr_392b54bc/quality.json`） [CLI 日志](p9-offline-quality-evidence/l1-normal-final.log) | 248/248 gatePassed true 退出 0 |
| 协议故障两轮 | 质量报告（本地文件 `p9-offline-quality-evidence/fault-final/evr_59e4c579/quality.md`） JSON（本地文件 `p9-offline-quality-evidence/fault-final/evr_59e4c579/quality.json`） [CLI 日志](p9-offline-quality-evidence/l1-fault-final.log) | 124/248 gatePassed false 退出 1 |
| 声明 fault 比较 | 摘要（本地文件 `p9-offline-quality-evidence/comparison-final/comparison.md`） JSON（本地文件 `p9-offline-quality-evidence/comparison-final/comparison.json`） | 可比 新增失败 124 修复失败 0 持续失败 0 退出 0 |
| 未声明变量比较 | JSON（本地文件 `p9-offline-quality-evidence/incomparable-final/comparison.json`） [日志](p9-offline-quality-evidence/incomparable-final.log) | 不可比 differences null 退出 2 |
| 原始链路复核 | 复核结果（本地文件 `p9-offline-quality-evidence/archive-verification-final.json`） | 496 个逐用例文件与持久附件相等 原账本费用吻合 源码哈希一致 |
| 校准准备 | 明确合成的格式与算法结果（本地文件 `p9-offline-quality-evidence/calibration-preparation.json`） | 真实数据 total 0 agreement null 尚未校准 |

正常报告的 248 条与故障报告的 248 条是两个实验 不合并为 496 条成功率 496 只用于说明实际解析证据的文件数量

## 命令

所有 pnpm 均带 --config.verify-deps-before-run=false 不安装依赖

```powershell
pnpm --config.verify-deps-before-run=false --filter @aftersales/eval exec vitest run test/p9-judge.test.ts
pnpm --config.verify-deps-before-run=false --filter @aftersales/eval exec vitest run test/p9-judge.test.ts test/p9-quality.test.ts
pnpm --config.verify-deps-before-run=false -r test
pnpm --config.verify-deps-before-run=false -r exec tsc --noEmit --incremental false
pnpm --config.verify-deps-before-run=false lint
git diff --check
```

本轮创建独立系统临时目录 具体路径记录于 temp-directory.txt 两个实验共用该目录下 shared-eval.db 没有使用默认 data/eval-p7.db 或演示业务库 重放应使用新的独立离线实验库和明确新实验计划 不拿更换身份当失败重试

```powershell
pnpm --config.verify-deps-before-run=false eval --offline --repeat 2 --db "$p9Temp/shared-eval.db" --output docs/experiments/p9-offline-quality-evidence/normal-final --experiment-id p9-final-normal-l1-two-rounds
pnpm --config.verify-deps-before-run=false eval --offline --repeat 2 --fault protocol-repeat-2 --db "$p9Temp/shared-eval.db" --output docs/experiments/p9-offline-quality-evidence/fault-final --experiment-id p9-final-protocol-fault-l1-two-rounds

pnpm --config.verify-deps-before-run=false exec tsx packages/eval/src/p9-cli.ts verify docs/experiments/p9-offline-quality-evidence/normal-final/evr_392b54bc
pnpm --config.verify-deps-before-run=false exec tsx packages/eval/src/p9-cli.ts compare docs/experiments/p9-offline-quality-evidence/normal-final/evr_392b54bc docs/experiments/p9-offline-quality-evidence/fault-final/evr_59e4c579 docs/experiments/p9-offline-quality-evidence/comparison-final fault
pnpm --config.verify-deps-before-run=false exec tsx packages/eval/src/p9-cli.ts compare docs/experiments/p9-offline-quality-evidence/normal-final/evr_392b54bc docs/experiments/p9-offline-quality-evidence/fault-final/evr_59e4c579 docs/experiments/p9-offline-quality-evidence/incomparable-final
```

verify 已在两次导出和两次 compare 中实际执行 额外归档复核再次使用同一校验器读取真实文件 未只检查字段存在 第二条故障命令和最后一条不可比命令非零是预期结果

## 首次失败和修正

1 初始外层工作区不是 Git 仓库 改为明确的 aftersales 子目录 初始状态及 HEAD 见 initial-worktree.txt（本地文件 `p9-offline-quality-evidence/initial-worktree.txt`） 原 IMPLEMENTATION 差异另存 initial-implementation.diff 未 reset clean checkout 或重新克隆
2 沙箱初次创建归档目录被拒 经自动审核允许的权限升级执行 没有停止向用户重复请求常规授权
3 [Judge 红灯](p9-offline-quality-evidence/judge-red.log) 8 项中 7 失败 复现不完整输出假通过 加入严格 JSON 唯一完整判据与完成标记 超时保护 最终 9/9
4 [首轮类型](p9-offline-quality-evidence/typecheck-first.log) 归档类型循环推断 改为显式接口 [首轮定向规范](p9-offline-quality-evidence/lint-directed.log) inline type import 不符合仓库规则 改为顶层导入
5 [首轮集成](p9-offline-quality-evidence/directed-first.log) 30/30 通过 含原 P7 8 项 [评测包中间检查](p9-offline-quality-evidence/eval-all-first.log) 82/82 后补 Judge 业务分离 模型变量与 held 三项 最终 [P9 定向](p9-offline-quality-evidence/directed-final.log) 25/25 全仓 eval 最终 85/85

6 最后消费者核对发现旧网页失败列表的 caseId 键和展开状态不能区分重复轮次 补齐兼容字段和复合键 同时确认 Judge 不影响业务类目指标 [补强定向](p9-offline-quality-evidence/consumer-final.log) 16/16 随后重新执行全仓 类型 ESLint 与两个正式 L1 实验 最终日志均以 final 命名 之前 normal fault comparison 和全仓日志保留为中间验收历史 费用未清零

## 数据与费用事实

全集 SHA256 7be6b01d0f8f8aced7e38dc2ee8c7b915fd492295fc3e279faada44fb98f705b

受控源码清单 SHA256 0664d59d2043cebd95216e936c01b6432ee97bb5c3ffa5a57b374ac0d58c2e96 两份报告相同 dirty=true 每个清单文件有自己的哈希 只说明受控范围内容 不声称工作树已提交或完整环境容器可复现

| 费用观察 | 最终正常实验 | 最终故障实验 | 原共享累计含前轮验收 |
| --- | ---: | ---: | ---: |
| attempts | 678 | 463 | 2282 |
| settled 次数 | 678 | 339 | 2034 |
| settled actual 微元 | 6780 | 3390 | 20340 |
| unknown 次数 | 0 | 124 | 248 |
| unknown reserved 微元 | 0 | 1240 | 2480 |
| held reserved 微元 | 0 | 0 | 0 |
| committed 微元 | 6780 | 4630 | 22820 |

最终正常实验开始时共享账本已有之前验收的 1240 微元 unknown 正常实验自身 unknown 为 0 但 scope 仍显示不确定费用 最终故障实验后累计 unknown 2480 微元 没有通过重置账本或清理 unknown 获得通过

全部为人工固定每次 10 CNY micro_yuan 与人工 usage 的模拟费用 不是真实供应商账单 故障第二轮不产生后续正常调用 所以已结算差值 -3390 不能解释为同质量节省 实际总费用差值 null 未知仍保持 actual=null

归档核验通过 better-sqlite3 readonly 连接原临时库 不调用迁移或写语句 逐实验 readP7CostReport.selection 与原导出相等 eval_budget_evidence.cases 与逐文件内容相等 SQLite integrity_check 为 ok 没有对账或清零未知费用

## 故障与安全覆盖

P9 回归覆盖全部轮次失败保留 旧格式 Zod 读取 数据集及源码清单 元数据内容哈希 不同版本拒绝 未声明模型和故障变量拒绝 声明模型后不能夹带超时配置变化 缺文件引用 重复用例 篡改内容 业务 run 错配 重复事件 模型调用证据缺失 服务装配失败 协议失败 超时 上游失败 实际预算预占阻断 无记录状态 held 和 unknown 原样保留

Judge 测试覆盖空数组 缺项 重复项 非布尔 未知判据 非法 JSON 重复输入 完整合法输出 超时和无完成事件 L2 真实离线消费者验证确定性业务 1/1 而 Judge 与综合端到端 0/1 原 Judge 输出可定位 合成标签仅验证算法 不启动真实调用

新注释精炼无标点 保留历史注释风格 不进行批量格式化 未读取 .env 未访问外部模型或真实资金 原进程回归使用自身独立临时库和随机本地端口 未启停已有 8787 8790 服务

完整字段兼容 身份关联 修改清单与 P10 或真实传输准备条件见 [P9 交接](../handoffs/p9-offline-quality.md)

最终 [差异检查](p9-offline-quality-evidence/diff-check-final.log) 退出码 0 前端仅兼容字段和列表身份 未重新执行浏览器视觉验收 不把该补丁称为 P9 评测网页交付

提交归档说明 完整 JSON 原始包保留本地且已加入忽略规则 仓库保存精简验收摘要与关键日志 重复中间实验包已清理 详见 docs/experiments/p9-validation-summary.md
