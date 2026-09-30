# P9 独立验收

日期 2026-09-26

后续更新 三项遗漏已修复 最终全仓 673/673 类型 ESLint 通过 正式 L1 正常 248/248 故障 124/248 原失败证据保留 见 [修复交接](p9-fixes.md) 下文为首次独立验收历史 不再代表当前状态

口径纠正 原 P7 active 同时包含未知费用的并发占位 修复不应强制归零 而应完成取消记账 保留 unknown/CANCELLED 占位并阻止迟到结果改变观察或费用

结论 P9 离线主流程可复现 但三项正确性遗漏尚未关闭 暂不标记最终验收通过 本轮只审查和新增验收证据 未修改生产实现

## P2 Judge 超时未结束底层调用

packages/eval/src/judge.ts 76 行 Promise.race 仅返回超时失败 没有取消或等待 consume 收尾

合成协议和原 suiteModels P7Gateway 独立内存账本均复现 Judge 超时返回时 active 为 1 模型观察事件为 0 返回后 active 变为 0 事件增为 2 表明失败判定与调用生命周期没有闭合 报告可能在观察与费用尚未稳定时归档

默认 offlineEvalRoles 单次网关超时为 5 秒 Judge 为 10 秒 因而当前快速离线正常实验未触发该窗口 但网关重试的总时间或更长受信快照可超过 Judge 时限 探针将 Judge 时限设为 5 毫秒 模拟传输延迟 60 毫秒以确定性暴露相同边界 没有真实付费调用

修复应复用已有取消和网关生命周期 在超时后传播取消并等待收尾 冻结观察与费用快照 不直接清除 held unknown 不新增裸模型超时旁路 回归要验证迟到事件不再修改已归档结果和活动调用释放

## P2 业务成功率与置信区间口径错配

packages/eval/src/report.ts 59 行使用 detail.passed 计算 task_success_rate 的 Wilson 区间 而 metrics.ts 的同名点估计排除了纯 Judge 失败

一个业务断言全过而 Judge 失败的 L2 用例 实测业务成功率为 1 同名区间为 [0, 0.7934567085261071] 区间估计的实际是综合通过率 对用户形成错误的同名统计

修复应共享同一指标分子分母 综合通过率如需区间单独命名 多轮同场景相关性和确定性模拟下区间解释需保持明确限制 不把模拟统计当真实置信结论

## P2 失败索引未纳入证据一致性校验

packages/eval/src/p9-report.ts verifyQualityBundle 读取原 case 并核对总数 但不验证 references 的 passed classes 与原 case 一致 也未读取 failures.json

将现有故障归档复制到临时目录 保留全部 248 个原始 case 文件 把 references 全改为 passed=true classes=[] 并将 failures.json 清空 校验仍返回成功 而原始 case 中仍有 124 个失败

这是导出摘要或索引损坏未被发现 不代表比较函数会直接将原 case 判为成功 该函数仍读取原 case 比较 修复应由已验证 case 重算引用状态和失败索引 并拒绝缺失 多余 重复或不一致记录 无需引入新的签名体系

## 复跑证据

证据目录 docs/experiments/p9-acceptance-evidence

- P9 定向 25/25
- 全仓单次 665/665 退出码 0 [全仓日志](../experiments/p9-acceptance-evidence/full-tests.log)
- 全仓非增量类型与 ESLint 退出码 0 [类型](../experiments/p9-acceptance-evidence/typecheck.log) [规范](../experiments/p9-acceptance-evidence/lint.log)
- 正式 L1 正常 124 个用例两轮 248/248 退出码 0 [正常日志](../experiments/p9-acceptance-evidence/normal.log)
- 正式 L1 第二轮协议故障 第一轮 124/124 第二轮 0/124 总计 124/248 预期退出码 1 [故障日志](../experiments/p9-acceptance-evidence/fault.log)
- 新建独立临时共享账本 正常 committed 6780 故障后累计 11410 CNY 微元 未知费用保留 全部为模拟费用
- 声明 fault 的对照可比 新增失败 124 实际总费用差值 null 比较（本地文件 `../experiments/p9-acceptance-evidence/comparison/comparison.json`）
- 三项遗漏的探针（本地文件 `../experiments/p9-acceptance-evidence/probe.ts`） 与 [实际输出](../experiments/p9-acceptance-evidence/probe.log)

命令沿用 pnpm --config.verify-deps-before-run=false 使用本地已有依赖 全仓为 -r test 类型为 -r exec tsc --noEmit --incremental false 正式入口 eval --offline --repeat 2 故障参数 --fault protocol-repeat-2 独立实验身份 p9-audit-normal 与 p9-audit-fault 原始实验没有改写或重置

## 下一步

先修上述三项并补边界回归 无需重做 P9 框架 修复后再次核对最终证据并收口

随后进入 P10 离线 Compose 与部署 优先验证默认无密钥启动 仅本机监听 持久卷 初始化不覆盖已有数据 重启任务及账本保持 模拟资金服务隔离 健康检查和操作说明 当前 where.exe docker 未发现命令 只能确认 PATH 不可用 不能断言系统完全没有安装 Docker 若无可用 Docker 环境只能做静态验收 不宣称容器启动通过

P11 导学及面试交付在最终行为稳定后推进 P5 真实 Embedding 仍锁定 真实供应商传输及 Judge 人工校准另立任务 当前不解锁

未 build 未读取 .env 或真实凭据 未操作演示数据库或既有服务 未启动真实模型 Embedding 或真实资金 未提交 Git

提交归档说明 完整 JSON 原始包保留本地且已加入忽略规则 仓库保存精简验收摘要与关键日志 重复中间实验包已清理 详见 docs/experiments/p9-validation-summary.md
