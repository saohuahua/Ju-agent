# P8 独立验收结果

日期 2026-09-26

后续修复已完成 原两项缺陷及四份归档脚本规范问题已关闭 全仓 640/640 类型 ESLint 通过 正式离线 L1 另计 124/124 见 [修复交接](p8-fixes.md) 下文保留首次独立验收结论和失败证据 不再代表当前状态

结论 暂不通过最终验收 P8 离线调查机制已基本实现 但不能标为全部完成 本轮只审查和复现 未修改生产实现 未弱化现有测试

验收范围为任务 A 的 P8 契约 持久关联 运行时 共享 P6 Worker 扩展 单多模式对照 运行记忆和恢复 并检查任务 B 汇合后的全仓回归 两个交付任务均已空闲

## P1 原有未知资金未完整进入运行记忆

位置 packages/runtime/src/p8-investigation.ts 的 businessReferences 和 packages/persistence/src/p8-investigation-repository.ts 的 unknownActions

真实 P6 资金结果未知时 原退款仍是 executing p6_effects 为 unknown 执行权为 sending 持久业务任务为 needs_confirmation P8 仅采集业务表状态 并按 unknown sending needs_confirmation processing 过滤 因此 executing 退款被漏掉

本轮不是直接往 refunds 填写 unknown 使用原 DurableConversation 与 DurableBusiness 经过领域建单和发送许可 调用独立本机模拟渠道的 unknown 模式 再捕获并运行 P8 实际得到

```text
refund.status executing
p6_effects.status unknown
execution_ownership.state sending
p6_tasks.status needs_confirmation
P8 memory.unknownActions []
P8 recommendation controlled_review
P8 investigationComplete true
```

这违反运行记忆必须保留原业务未知结果并交人工核验的要求 P8 本身没有执行退款 因而本次没有第二笔资金动作 但当前建议错误地漏掉关键风险

原测试直接插入 refund.status unknown 不是正常 P6 的未知资金状态 不能证明该真实边界已覆盖

修复要求 从原资金效果 执行权及相关任务读取权威状态 并与原客户订单业务资源校验关联 保留业务表原状态 不把它伪造改成 unknown 加入真实 P6 未知链路回归 unknownActions 非空 建议 human_review investigationComplete 为 false 不重获发送许可

[原始复现](../experiments/p8-acceptance-evidence/unknown-business-reproduction.json)

## P2 源记录更新破坏已受理请求重放

位置 packages/runtime/src/p8-investigation.ts validateAndAccept 与 packages/persistence/src/p8-investigation-repository.ts accept

当前先重查最新源记录并比对输入原文 最后才查询原父任务是否已经受理 在原 input 成功受理并完成后 只增加订单 version 再次提交完全相同 input 会抛 P8 原文与源记录冲突 返回不了原 taskId

这不是新请求使用陈旧事实的问题 已受理请求的身份和冻结输入都没有改变 受理响应丢失后调用者应能通过原身份找回原任务 当前会因合法的后续订单变化而失败

修复要求 先核对同客户同实验身份是否已有受理 对同参重放返回原任务 对异参明确冲突 仅首次受理校验最新源事实 不更新已冻结输入 不通过更换 caseId repeat 或另建任务绕过问题

[原始复现](../experiments/p8-acceptance-evidence/idempotent-replay-reproduction.json)

## 独立集成问题 全仓 ESLint 未通过

33 项 no-undef 来自任务 B 归档目录 customer-return-shipment-ui-evidence 下的 browser-check.mjs final-ui-check.mjs finish-check.mjs pending-switch-check.mjs 涉及 fetch document innerWidth

这不是 P8 运行时业务缺陷 但不满足两个并行任务汇合后的规范检查门槛 应为实际 Node 与浏览器执行片段补准确且限定文件范围的环境声明 不删除实验记录或关闭全仓规则

[完整规范日志](../experiments/p8-acceptance-evidence/full-lint.log)

## 已通过及证据边界

- 全仓单次 633/633 测试通过 含 P8 27 项及原 P6 P7 和任务 B 测试
- 全仓非增量类型检查通过 git diff --check 通过
- 正式离线 L1 数据集另计 124/124 通过 与单元集成分母不相加
- P8 独立 CLI 四组串并行对照复跑通过 相同证据和政策 建议兼容
- 对照共 16 次 settled 模拟调用 160 CNY 微元 受控延迟不代表真实性能
- L1 共 339 次模拟调用 3390 CNY 微元 未产生真实模型费用

上述通过不覆盖已复现的两项缺陷 现有测试需要增加真实状态和重放场景 而不是用通过总数替代业务不变量

没有重新执行任务 B 浏览器交互 本轮读取其已有交接和证据 全仓测试包含其新增 API Web 回归 不宣称完成了新一轮浏览器验收

## 本轮修改与后续

只新增本验收报告 验收探针和原始证据 并更新进度文档记录未通过结果 保留所有已有未提交成果 未更改生产业务代码 未读取 .env 未启动真实模型或资金 未操作演示库或 8787 8790 未 build

修复 P1 和 P2 后补充定向回归 处理独立脚本规范问题 再对最终冻结工作树执行完整回归并更新验收 不要求重做已有 P8 调度 账本或对照框架 P5 保持锁定
