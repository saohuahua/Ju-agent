# P7 剩余生产入口收口

日期 2026-09-26

## 本轮执行 Prompt

在保留已有成果的前提下 收口 legacy API 和政策 scorer 的直接模型调用 复用现有 P7Gateway 账本和评测实现 本轮继续禁用真实传输 可以明确关闭旧入口 不要求为兼容旧入口另造调用体系 从正式入口验证无法绕过网关 回归现有离线评测和退款流程 交付入口审计 修改清单 实测证据及剩余边界 不 build 不读取真实密钥 不启动真实实验 不解锁 P5

## 编码前核对与选择

当前 P7 核心网关 快照 协议 共享账本 正式离线评测和费用报告已完成 不重新实施 不修改其字段 身份或预算语义

确认 main.ts 是生产代码中唯一构造 AnthropicModel 的位置 非 simulation 模式读取 .env 后根据密钥启用真实模型 compose.ts 默认将同一模型隐式注入政策 scorer 这是已确认的剩余入口缺口

选择关闭旧真实入口 main 不再读取 .env 或模型凭据 不导入或构造供应商模型 非 simulation 模式仅提供禁用占位 显式非法或 live 模式在数据库初始化前拒绝 simulation 沿用已验收的持久离线退款装配

政策检索默认复用 KeywordPolicyScorer 不再暗中复用主模型发起付费打分 该变化明确表示关键词基线而非 LLM 精排 仍保留显式 scorer 注入用于测试和已有 P7 消费者验证

createApp 的 modelAvailable 只守卫新建运行 旧会话恢复等入口也能调用 runner 因此不能仅修改 available 布尔值 必须从装配中彻底移除真实模型 已有通用 composeSystem 和 ChatModel 接口属于可信代码注入边界 不把任意外部代码的能力误称为已经沙箱隔离

并行只读审计负责独立检查遗漏 主任务独占源码 测试与交接修改 相关既有项目任务均为空闲 无并发修改同文件

不新增真实传输 自动费用对账 跨进程评测续跑或未存在的模型用途 不扩大为另一轮全用途框架建设

## 实施结果与入口矩阵

| 入口 | 本轮结果 |
| --- | --- |
| 正式 main 默认模式 | 模型不可用 新建对话返回 503 不读模型凭据 不构造供应商实例 |
| 正式 main 显式 live 或其他非法模式 | LIVE_DISABLED 在打开数据库前拒绝 |
| 正式 main simulation | 继续复用已有 P7 持久离线会话与本地退款装配 |
| main 内旧运行消息与断点恢复 | 共用 DisabledApiModel 明确产生 LIVE_DISABLED 失败 无供应商传输 不伪造完成 |
| 默认政策 scorer | KeywordPolicyScorer 确定性关键词 不消费主模型 不新增模型账本行 |
| 正式 L1 L2 CLI 与 API 评测 | 已有 P7 路径保持不变 不重新迁移 |
| scripts/demo desk-demo durable-demo | 已是离线脚本或持久 P7 不是付费旁路 |
| rag-baseline 与数据脚本 | 无模型调用 不扩展为本轮新用途 |
| AnthropicModel 与 ChatModelPolicyScorer 类 | 保留现有适配器及独立消费者测试 正式默认装配不再调用 |

并行子任务独立只读检索非测试源码与脚本 未发现其他正式供应商模型装配点 复核还指出旧 SDK 使用独立 node-fetch 因此本轮测试探针覆盖全局 fetch 以及 node:http node:https 并验证三类请求均被阻断

## 修改文件

- apps/api/src/model-entry.ts 新增正式模式选择与明确拒绝的旧模型端口
- apps/api/src/main.ts 删除供应商与环境文件装配 模式拒绝先于数据库初始化
- apps/api/src/app.ts 更新模型不可用提示 不再诱导通过设置密钥启用旧路径
- packages/runtime/src/compose.ts 默认政策打分改为原关键词基线
- apps/api/test/p7-entry-closure.test.ts 新增模式门禁 旧模型端口和默认 scorer 测试
- apps/api/test/p7-entry-closure-process.test.ts 新增真实 main 子进程与探针自检
- apps/api/test/fixtures/p7-entry-guard.mjs 新增离线验收网络及环境文件探针
- 本交接 实验记录 证据目录及交接备案

未修改现有网关 快照 账本字段 费用计算 评测工厂 身份编码或报告模块 未修改 P6 资金流程

## 兼容与剩余边界

正式 main 不再自动加载 .env 非模型配置如 DB_PATH API_PORT OPERATOR_TOKEN SUPERVISOR_TOKEN 需由启动进程环境提供 本轮没有读取或修改用户实际环境文件

默认政策检索是关键词基线 不宣称保持或提高原 LLM 精排质量 显式注入的 PolicyArticleScorer 与 ChatModel 仍是可信程序接口 不是运行任意第三方代码的网络沙箱 测试探针也不是生产安全隔离设施

保留 AnthropicModel 代码不表示真实供应商已受控接入 未来真实传输仍需价格 配置 凭据 取消 usage SDK 重试及预算授权的专项实施和验证 已有 P7Gateway LIVE_DISABLED 不放开

未知费用继续保守占用 跨进程评测续跑与自动对账本轮不实现 不把这些后续增强列为已完成成果

旧评测网页仍有配置密钥开启 L2 的历史提示 后续 UI 清理时修正 当前后端已拒绝真实模式 不为该文案扩大本轮文件范围 客户结构化寄回控件仍是可独立推进的产品任务

## 验收状态

定向 8 项通过 其中 3 项启动真正 main 入口 1 项自检网络探针 全仓最终结果与证据见 [实验记录](../experiments/p7-entry-closure.md)

最终全仓 594/594 全部通过 全仓类型 ESLint 差异检查通过 正式离线 L1 另计 124/124 通过 L1 账本 339 次模拟调用 3390 微元 无未知费用 未发生真实模型费用

当前阶段应表述为 P7 核心与离线集成完成 且已识别的剩余正式真实模型入口关闭 不等于已完成真实模型接入或质量验证 P5 保持锁定 不启动真实实验

## 完成复核

用户要求继续确保完成后 重新核对正式入口 源码修改时间与最终验收证据 未发现本 Prompt 内未完成项 7 个源码与测试文件均未在最后全仓回归开始后修改 本次没有重复实施或重跑相同测试 [完成复核清单与当前源码哈希](../experiments/p7-entry-closure-evidence/completion-check.json)
