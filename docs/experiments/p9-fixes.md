# P9 修复实测

日期 2026-09-26 所有命令在 aftersales 执行 pnpm 均带 --config.verify-deps-before-run=false 不安装依赖

## 首次失败与修复

新增八项回归初次全部失败 [红灯日志](p9-fix-evidence/red.log) 覆盖 Judge 超时传播 业务区间及六种引用或失败索引问题

首次修复后七项通过 余下一项错误要求 active 为零 [首次绿灯尝试](p9-fix-evidence/green-first.log) 核实原 P7Ledger.totals 明确保留 unknown/CANCELLED 的并发占位 因而修正测试验收口径为 unknown actual=null outcome=CANCELLED active=1 没有修改账本实现或减少预留金额

兼容性复核发现简单等待所有模型收尾会挂住原不支持取消的替身 因此新增可选取消能力 正式 P7 适配器等待收尾 旧适配器保留限时返回 原 p9-judge 测试未删除或弱化

补强前已启动的 full-tests.log normal fault 为中间证据 最终以 final 日志为准 最终离线实验复用本轮独立临时账本 保留前轮未知费用 不清零预算

## 最终检查

- pnpm --filter @aftersales/eval exec vitest run test/p9-fixes.test.ts test/p9-judge.test.ts test/p9-quality.test.ts test/p7-eval-budget.test.ts test/p7-entry.test.ts 61/61 退出码 0 [定向日志](p9-fix-evidence/green-final.log)
- pnpm -r exec tsc --noEmit --incremental false 退出码 0 [类型日志](p9-fix-evidence/typecheck-final.log)
- pnpm lint 退出码 0 [规范日志](p9-fix-evidence/lint-final.log)
- pnpm -r test 673/673 退出码 0 [最终全仓日志](p9-fix-evidence/full-tests-final.log)

全仓与正式 L1 为独立分母 不与定向重复相加 全仓分包为 Web 32 contracts 15 domain 92 persistence 103 tools 18 workflow 10 agent 22 runtime 155 eval 93 API 133 新增八项包含其中

## 正式离线实验

数据库位置仅用于定位本轮新建临时库 见 p9-fix-evidence/database-path.txt 没有打开或迁移用户演示数据库

```powershell
pnpm --config.verify-deps-before-run=false eval --offline --repeat 2 --db 本轮独立临时库 --output docs/experiments/p9-fix-evidence/normal-final --experiment-id p9-fix-final-normal
pnpm --config.verify-deps-before-run=false eval --offline --repeat 2 --fault protocol-repeat-2 --db 本轮独立临时库 --output docs/experiments/p9-fix-evidence/fault-final --experiment-id p9-fix-final-fault
```

正常和故障是两个预先声明的实验 各为 124 个固定用例两轮 不通过更换身份来重试失败调用 故障报告应保持第二轮失败 退出码 1 为预期结果

[正常日志](p9-fix-evidence/normal-final.log) [故障日志](p9-fix-evidence/fault-final.log)

正常两轮 248/248 gatePassed=true 退出码 0 正常质量包（本地文件 `p9-fix-evidence/normal-final/evr_18c196b2/quality.json`）

故障第一轮 124/124 第二轮 0/124 合计 124/248 gatePassed=false 退出码 1 故障质量包（本地文件 `p9-fix-evidence/fault-final/evr_c61da38b/quality.json`）

声明 fault 的对比可比 新增失败 124 实际总费用差值 null 退出码 0 对比结果（本地文件 `p9-fix-evidence/comparison/comparison.json`） 不声明变量则不可比 differences=null 退出码 2 拒绝结果（本地文件 `p9-fix-evidence/incomparable/comparison.json`）

最终正常实验本身 settled 为 6780 CNY 微元 故障实验 settled 为 3390 unknown reserved 为 1240 微元 共享账本包含中间两组验收 最终 committed 为 22820 微元 unknown reserved 为 2480 微元 未通过清零未知费用获得通过 不把已结算差值称作实际费用节省

原 P9 完整历史故障包 evr_59e4c579 仍可通过新校验器 248 个实际用例文件均可读取 [兼容核验](p9-fix-evidence/legacy-verify.log) 新增回归中的缺失或篡改索引均被拒绝 不要求重做历史格式

比较命令为 pnpm exec tsx packages/eval/src/p9-cli.ts compare 左目录 右目录 输出目录 fault 去掉 fault 验证不可比 兼容命令为 pnpm exec tsx packages/eval/src/p9-cli.ts verify docs/experiments/p9-offline-quality-evidence/fault-final/evr_59e4c579

所有费用均为人工固定价格与模拟 usage 不是真实供应商费用 未校准真实 Judge 未开启真实模型实验 P5 保持锁定

提交归档说明 完整 JSON 原始包保留本地且已加入忽略规则 仓库保存精简验收摘要与关键日志 重复中间实验包已清理 详见 docs/experiments/p9-validation-summary.md
