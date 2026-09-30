# 人工接管寄回接口修复

日期 2026-09-26

原 POST /api/runs/:runId/messages 在 handling_human 分支忽略 returnShipment 保存普通留言并返回 200 客户可能把请求成功误解为寄回已登记

现保持原客户归属和角色检查 在留言写入前明确拒绝结构化寄回 返回 409 CONFLICT 并提示联系坐席核验 普通客户留言仍保存 message.user 返回 200 不新增人工寄回受理路径 不修改原退款执行权或领域规则

修改 apps/api/src/app.ts 与 apps/api/test/customer-progress.test.ts 将原记录缺陷行为的测试更新为回归断言 覆盖正式 HTTP 发起退货 后续人工接管 重复结构化寄回拒绝且数据库 total_changes 不变 越权客户 403 普通留言只新增一次消息 渠道 submissions 和 charges 均为零

## 实测

所有 pnpm 命令带 --config.verify-deps-before-run=false

- 修复前 pnpm --filter @aftersales/api exec vitest run test/customer-progress.test.ts -t 人工接管后 失败 预期 409 实际 200 [红灯证据](../experiments/human-return-fix-evidence/red.log)
- 修复后 pnpm --filter @aftersales/api exec vitest run test/customer-progress.test.ts test/api.test.ts test/conversation-refund.test.ts 45/45 退出码 0 [通过日志](../experiments/human-return-fix-evidence/green.log)
- pnpm --filter @aftersales/api exec tsc --noEmit --incremental false 退出码 0 [类型日志](../experiments/human-return-fix-evidence/typecheck.log)
- pnpm exec eslint apps/api/src/app.ts apps/api/test/customer-progress.test.ts 退出码 0 [规范日志](../experiments/human-return-fix-evidence/lint.log)

仅运行与该接口相关检查 未重新运行全仓及 L1 上一轮 640/640 和 L1 124/124 为 P8 修复时历史全仓基线 本次替换一项测试 不增加测试总数 不将 45 项与其相加

独立临时数据库和随机本地模拟渠道 未 build 未读真实密钥 未调用外部模型或真实资金 未改演示库 未启停已有服务 未修改前端或重跑浏览器 无新增调试埋点
