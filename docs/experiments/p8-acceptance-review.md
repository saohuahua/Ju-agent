# P8 集成验收实测

日期 2026-09-26

后续更新 两项缺陷和规范问题已修复 最终全仓 640/640 类型 ESLint 通过 正式离线 L1 另计 124/124 见 [修复实测](p8-fixes.md) 下文为首次验收记录

本次验收发现两项可复现正确性缺陷及一项独立集成规范问题 结论见 [验收报告](../handoffs/p8-acceptance-review.md) 不标记 P8 全部完成

## 命令与结果

| 命令 | 实测结果 |
| --- | --- |
| pnpm --config.verify-deps-before-run=false -r test | 退出码 0 单次 633 项通过 |
| pnpm --config.verify-deps-before-run=false -r exec tsc --noEmit --incremental false | 退出码 0 |
| pnpm --config.verify-deps-before-run=false lint | 退出码 1 四份任务 B 浏览器归档脚本共 33 项 no-undef |
| pnpm --config.verify-deps-before-run=false eval --offline --db 独立临时库 --output docs/experiments/p8-acceptance-evidence/l1-reports --experiment-id p8-acceptance-l1 | 退出码 0 L1 124/124 |
| pnpm --config.verify-deps-before-run=false exec tsx packages/eval/src/p8-offline-cli.ts docs/experiments/p8-acceptance-evidence/comparison | 退出码 0 四组同证据对照完成 |
| pnpm --config.verify-deps-before-run=false exec tsx docs/experiments/p8-acceptance-evidence/unknown-business-probe.ts | 退出码 0 成功复现未知资金遗漏和原请求重放报错 |
| git diff --check | 退出码 0 |

全仓分包为 Web 32 contracts 15 domain 92 persistence 103 tools 18 workflow 10 agent 22 runtime 148 eval 60 API 133 合计 633 其中 runtime 包含 P8 27 项

## 原始证据

- [开始工作树](p8-acceptance-evidence/start-status.txt)
- [全仓测试](p8-acceptance-evidence/full-tests-first.log)
- [类型检查](p8-acceptance-evidence/full-typecheck.log)
- [首次规范失败](p8-acceptance-evidence/full-lint.log)
- [L1 日志](p8-acceptance-evidence/l1-first.log)
- [L1 报告](p8-acceptance-evidence/l1-reports/evr_22a631be.json)
- [L1 费用附件](p8-acceptance-evidence/l1-reports/evr_22a631be.evidence.json)
- [P8 四组对照报告](p8-acceptance-evidence/comparison/report.json)
- [缺陷复现脚本](p8-acceptance-evidence/unknown-business-probe.ts)
- [复现输出](p8-acceptance-evidence/reproduction.log)
- [真实未知资金遗漏](p8-acceptance-evidence/unknown-business-reproduction.json)
- [同参幂等重放失败](p8-acceptance-evidence/idempotent-replay-reproduction.json)

缺陷探针使用独立内存数据库和随机本地模拟渠道 只调整基础订单物流夹具为丢件 售后单和资金任务由已有正式运行时生成 原渠道只收到一次提交 charges 为 0 未发生真实资金动作

源版本变化场景复用已经持久完成的同一 P8 input 仅更新原订单 version 不更改客户 输入 证据或实验身份 因而排除异参请求冲突

对照与 L1 使用各自新建临时数据库 保存归档和日志 没有重置用户演示库 未读取真实密钥 不执行 build 不解锁 P5
