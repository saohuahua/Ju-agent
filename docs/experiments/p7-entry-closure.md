# P7 剩余生产入口收口实验

日期 2026-09-26

本轮只关闭已确认的 legacy API 与隐式政策 scorer 付费旁路 不重新实现 P7 不创建真实模型传输 不读取真实密钥或 .env 不操作原演示库 不启停 8787 或 8790 不 build

## 起始与并行安排

[起始工作树](p7-entry-closure-evidence/start-status.txt) 保留本轮之前全部成果 未 reset clean checkout 或重新克隆

查看任务列表确认 实现 P7 评测预算适配 实现 P7 只读费用报告 完成 P6 验收并接入 P7 评测入口 均为空闲 主任务独占本轮源码与测试修改 子任务只读审计入口并复核最终实现 没有把已有模块重新派发实施

## 定向证据

8 项定向测试通过 [最终定向日志](p7-entry-closure-evidence/directed-final.log)

| 场景 | 证据 |
| --- | --- |
| 模式装配门禁 | live anthropic production 拒绝 默认不可用 simulation 仅离线快照 |
| 两种模式的旧模型端口 | 均明确抛 LIVE_DISABLED 不产生文本或工具事件 |
| 默认政策检索 | 返回真实关键词命中文档 主模型 spy 调用数 0 账本行数 0 |
| 探针自检 | fetch http.request https.get 三种请求均在发送前阻断 |
| 实际 main 默认模式 | 虚构供应商配置不能解锁 新建 503 旧续聊和恢复均以 LIVE_DISABLED 失败 run.completed 数 0 账本行数 0 网络探针数 0 |
| 实际 main live 模式 | 退出码非零 错误 LIVE_DISABLED 数据库文件未创建 环境文件和网络探针数均 0 |
| 实际 main simulation | 正式客户 HTTP 返回 202 持久查询完成 账本两条 main_agent settled 每条模拟零价 无外部模型传输 |

三项 main 实验均启动 apps/api/src/main.ts 使用独立临时业务库 API_PORT=0 只向子进程传入所需系统字段和明确虚构的模型凭据 不继承真实模型配置 环境文件读取探针在文件访问前拒绝供应商配置文件 所有环境文件与出站模型网络计数均为零

simulation 两条调用为原演示人工零价协议 不是供应商免费报价 默认模式零账本行表示没有发起调用 不能用于推断任何外部真实请求免费

## 首次失败与补强

首次定向运行 4 项通过 3 项进程测试失败 Windows --import 不接受盘符绝对路径 改用 pathToFileURL 保留原验证断言 [首次日志](p7-entry-closure-evidence/directed-first.log)

首次类型检查发现 executor 返回的字段类型为 unknown 测试改用原 ToolIO.search_policy.output.parse 解析 没有强制类型断言或弱化非空结果检查 [记录](p7-entry-closure-evidence/first-typecheck.txt)

并行复核指出 SDK 自有 node-fetch 不经过全局 fetch 初版探针覆盖不足 增加 http https 拦截和自检 并对两个旧运行逐一断言 LIVE_DISABLED 补强前全仓记录作为中间版本保留 不替代最终版本

## 执行命令

```powershell
pnpm --config.verify-deps-before-run=false --filter @aftersales/api exec vitest run test/p7-entry-closure.test.ts test/p7-entry-closure-process.test.ts
pnpm --config.verify-deps-before-run=false --filter @aftersales/api exec tsc --noEmit --incremental false
pnpm --config.verify-deps-before-run=false -r test
pnpm --config.verify-deps-before-run=false -r exec tsc --noEmit --incremental false
pnpm --config.verify-deps-before-run=false lint
pnpm --config.verify-deps-before-run=false eval --offline --db <独立临时数据库> --output docs/experiments/p7-entry-closure-evidence/l1-reports --experiment-id p7-entry-closure-l1
git diff --check
```

## 最终结果

最终全仓单次运行 **594/594 通过** 退出码 0 新增 8 项已包含其中 不重复相加 [最终日志](p7-entry-closure-evidence/full-tests-final.log)

分包数量为 Web 28 contracts 15 domain 92 persistence 103 tools 18 workflow 10 agent 22 runtime 121 eval 60 API 125

全仓非增量类型检查 ESLint 与 git diff --check 均通过 [类型日志](p7-entry-closure-evidence/full-typecheck-final.log) [规范日志](p7-entry-closure-evidence/full-lint-final.log) 只格式化本轮修改文件 未批量格式化历史工作树

补强前全仓 593 项通过记录保存在 full-tests-first.log 最终验收使用 594 项版本 原 P6 普通退款业务和全部进程恢复测试在最终回归内通过

最终实际 main 子进程证据目录为 `p7-entry-closure-evidence/2026-09-26T03-52-13.124Z`

- [默认禁用及旧运行恢复](p7-entry-closure-evidence/2026-09-26T03-52-13.124Z/disabled.json)
- [真实模式拒绝](p7-entry-closure-evidence/2026-09-26T03-52-13.124Z/live-rejected.json)
- [持久离线查询及账本](p7-entry-closure-evidence/2026-09-26T03-52-13.124Z/simulation.json)

各记录保留独立实验目录探针结果进程日志与运行状态 旧运行失败消息明确为 LIVE_DISABLED 不存在 run.completed 事件 环境文件访问和出站模型网络探针为空

正式离线 L1 124/124 通过 单独统计 不与单元及集成测试分母相加 [日志](p7-entry-closure-evidence/l1-first.log) [业务报告](p7-entry-closure-evidence/l1-reports/evr_10c92f48.json) [费用身份附件](p7-entry-closure-evidence/l1-reports/evr_10c92f48.evidence.json)

L1 原共享账本记录 339 次离线调用 3390 CNY micro_yuan 无 unknown held 生产价格未验证 未发生真实模型费用 独立库已保存为 p7-entry-closure-evidence/l1.db

## 限制

只完成已识别正式入口的关闭 不等于实现受控真实传输或验证真实模型质量 默认 scorer 行为变为关键词基线 .env 不再自动加载 非模型配置通过启动进程环境提供 通用代码依赖注入仍属于受信边界

本轮不新增 Embedding rerank sub_agent 用途 不做自动费用对账或评测续跑 不修改 P6 退款资金语义 不解锁 P5 不启动真实实验
