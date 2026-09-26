# P8 缺陷修复实测

日期 2026-09-26

## 失败证据与修正

中断前新增七项回归 首次六项失败 一项通过 [原始红灯](p8-fix-evidence/regression-red.log) 分别证明真实未知资金遗漏 legacy 许可遗漏 归属冲突误认为成功和三个阶段的幂等重放失败

续做时修复实现已落盘但未验证 补齐遗漏的 P8BusinessReference 类型导入 仅格式化本轮文件 首次定向运行新增七项全部通过 原有三项失败 [首次集成日志](p8-fix-evidence/regression-first.log)

原审批测试夹具使用 return 而正式领域使用 return_request 已修正夹具 保留审批引用和 pending 状态断言 原篡改测试因幂等冲突先发生而错误消息改变 现在同时验证同键异参冲突及新请求源事实拒绝 未删除安全断言

默认沙箱拒绝格式化及日志写入 后通过自动审核的提权命令执行 未因权限问题修改检查规则

## 实测命令

所有 pnpm 命令均带 --config.verify-deps-before-run=false 不安装依赖

| 命令 | 结果及证据 |
| --- | --- |
| pnpm --filter @aftersales/runtime exec vitest run test/p8-fixes.test.ts test/p8-investigation.test.ts test/p8-process.test.ts | 34/34 退出码 0 [定向日志](p8-fix-evidence/regression-green.log) |
| pnpm -r exec tsc --noEmit --incremental false | 退出码 0 [类型日志](p8-fix-evidence/full-typecheck.log) |
| pnpm lint | 退出码 0 [规范日志](p8-fix-evidence/full-lint.log) |
| pnpm -r test | 640/640 退出码 0 [全仓日志](p8-fix-evidence/full-tests.log) |
| pnpm eval --offline --db 独立临时库 --output docs/experiments/p8-fix-evidence/l1-reports --experiment-id p8-fix-l1 | 124/124 退出码 0 [L1 日志](p8-fix-evidence/l1.log) |
| pnpm exec tsx packages/eval/src/p8-offline-cli.ts docs/experiments/p8-fix-evidence/comparison | 四组同证据同政策建议兼容 退出码 0 [对照报告](p8-fix-evidence/comparison/report.json) |
| pnpm exec tsx docs/experiments/p8-fix-evidence/unknown-business-probe.ts | 退出码 0 原两个缺陷不再复现 [探针日志](p8-fix-evidence/reproduction-fixed.log) |

L1 为正式离线数据集 分母不与单元集成测试相加 [报告](p8-fix-evidence/l1-reports/evr_6754112e.json) [费用附件](p8-fix-evidence/l1-reports/evr_6754112e.evidence.json) 339 次 settled 模拟调用 3390 CNY 微元 held 和 unknown 均为零 没有真实模型费用

全仓分包为 Web 32 contracts 15 domain 92 persistence 103 tools 18 workflow 10 agent 22 runtime 155 eval 60 API 133 合计 640 新增七项已包含在内 不与定向回归重复相加

P8 四组八次运行共 16 次模拟调用 160 CNY 微元 使用受控本地等待 不代表真实模型质量或性能提升

## 修复后的业务事实

[未知资金原始记录](p8-fix-evidence/unknown-business-reproduction.json) 来自原 DurableConversation 和 DurableBusiness 领域建单及持久执行 资金渠道为随机本地端口和独立内存库

- 业务退款 executing 效果 unknown 许可 sending 任务 needs_confirmation
- unknownActions 包含原退款及匹配的资金证据 bindingValid 为 true
- recommendation 为 human_review investigationComplete 为 false
- 渠道 submissions 为 1 charges 为 0 P8 没有产生第二次提交
- 七项回归另验证正常成功退款 submissions 为 1 charges 为 1 不误报未知

[同参重放记录](p8-fix-evidence/idempotent-replay-reproduction.json) 显示源订单版本增加后 returnedTaskId 等于 originalTaskId 原始失败证据仍保留在 p8-acceptance-evidence

本次仅离线模拟 无真实供应商质量结论 P5 保持锁定 无 build
