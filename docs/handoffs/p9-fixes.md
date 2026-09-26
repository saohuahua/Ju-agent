# P9 三项验收遗漏修复

日期 2026-09-26

本轮接续 P9 独立验收 只修复 Judge 超时收尾 成功率区间口径和失败索引验证 保留原交付及验收失败证据 不重做评测框架

## 行为变化

Judge 超时通过单次 AbortSignal 传入原 P7 评测模型工厂 与套件取消信号合并 观察器透传信号和取消能力 Judge 等待原网关调用及观察器结束后才返回失败 因此报告不再采集仍会变化的 P7 调用观察

ChatModel 新增可选 supportsCancellation 和可选 stream 第二参数 已有实现保持兼容 只有声明支持取消的适配器才等待收尾 正式 P7 评测工厂声明并实现该契约 旧不支持取消的独立替身仍限时返回且迟到事件不参与 Judge 判定 不声称能强制停止任意忽略取消信号的外部代码

没有修改 P7Gateway P7Ledger 的费用或并发算法 无 usage 的取消按原规则从 held 变成 unknown outcome 为 CANCELLED 预留金额和并发占位保留 后续迟到响应不能修改观察或费用 只取消本次 Judge 不取消其他角色或原套件

验收中 active 的解释需纠正 原账本 active 包含需要核验的 unknown 并发占位 不等于本地消费协程数量 因此不能以强制 active 归零验收 本轮验证 abort 已传播 调用已记录 CANCELLED 未知费用保留 观察与账本在迟到响应后不变

业务 task_success_rate 的点估计和 Wilson 区间共用 businessSuccessCount 分子 纯 Judge 失败只影响综合通过 不改变业务成功分子 综合 passed 与门禁仍按原规则 区间保留原统计方法 不代表已验证独立样本或真实模型随机稳定性

证据校验从原 case 重算并核对 references.passed references.classes 再读取 failures.json 核对完整索引 缺失 清空 多余 重复或内容不一致均拒绝 原始一致的历史 P9 包继续可读取 不改变数据 schema 或 P7 身份编码

## 修改文件

- packages/agent/src/model.ts 可选取消能力和信号参数
- packages/eval/src/p7-eval-models.ts 单次与套件取消信号合并
- packages/eval/src/p7-suite-entry.ts 观察器保留取消能力并透传
- packages/eval/src/judge.ts 超时取消及等待原调用收尾
- packages/eval/src/metrics.ts 和 report.ts 业务点估计和区间共用分子
- packages/eval/src/p9-report.ts 验证引用判定及失败索引
- packages/eval/test/p9-fixes.test.ts 新增八项回归
- 本交接 实验记录和共享状态入口更新

原 p9-judge.test.ts 的不响应取消替身测试最终保持不变 不通过改成配合取消的替身掩盖兼容性退化 原有预算 取消 费用占位与消费者断言保留

## 验收

最终全仓 673/673 全仓非增量类型 ESLint 通过 定向 61/61 正式离线 L1 正常两轮另计 248/248 故障两轮 124/248 如实失败 报告比较及历史完整包兼容检查通过 三项验收遗漏已关闭 P9 离线最小闭环可收口

详见 [修复实测](../experiments/p9-fixes.md) 和其中最终日志 原红灯与中间验证全部保留 不将多次测试分母相加

新增八项覆盖原网关超时及迟到响应 其他角色隔离 业务区间口径 以及六种失败引用和索引损坏 本轮仍只验证离线机制 真实 Judge 未校准 P5 保持锁定

后续可进入 P10 离线部署 准备 Docker 实测环境 验证无密钥启动 本机访问 持久卷和重启恢复 无 Docker 则只能标记静态验收 P11 完整学习交付随后推进

未 build 未读环境文件或真实凭据 未访问真实模型 Embedding 或资金 未操作演示库或既有服务 未提交 Git

提交归档说明 完整 JSON 原始包保留本地且已加入忽略规则 仓库保存精简验收摘要与关键日志 重复中间实验包已清理 详见 docs/experiments/p9-validation-summary.md
