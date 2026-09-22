# AfterSales Copilot 可评测 可恢复的电商售后 Agent 平台

面向退换货 退款与补偿流程的业务 Agent 系统 覆盖多轮澄清 政策判定 人工审批 幂等退款
断点恢复与两级回归评测 核心命题是 **让 Agent 在有副作用的业务里安全工作 并能用数据证明它做对了**

不是客服聊天机器人 副作用治理与评测闭环才是这个项目的主体

## 核心能力

- **原生 Agent 循环** 模型经原生 tool calling 决策（tool_use 块 + 工具参数流式增量） ask_user 协议工具承接多轮澄清 旧 JSON 协议已废除
- **混合架构** 模型负责理解与决策 副作用路径固化为确定性工作流 资金动作永不直接经过模型
- **真流式** 文本与工具参数逐 token 落事件表 SSE 透传 断线补发 刷新重建
- **上下文工程** working memory 状态便签 + 最近消息 + 超限确定性压缩 压缩效果落 context.compacted 事件可量化
- **能力门控** 未查过订单前 业务动作工具不出现在模型的工具目录 结构性防盲提交 而非提示词恳求
- **副作用安全** 业务幂等键 一次性审批令牌 网关级去重三道防线 重复退款被结构性排除
- **现金红包补偿** 物流延误与服务道歉安抚 50 元分界分级 小额自动发放 大额人工审批 同订单同原因仅一次
- **价保流程** 签收后 7 天窗口 SKU 明细差价全额退 大额走人工审批 同一订单仅可价保一次
- **物流事件推送** 运营注入物流状态变化 空闲会话即达即触达主动告知 忙时挂起下一轮 已签收订单拒绝回退
- **人工接管闭环** escalated 不再是死终态 坐席工作台接管（handling_human）双向对话 标记解决回 completed 权限分离 AI 不碰终审 坐席不碰执行
- **运营分析 + CSAT** 会话量 解决率 升级率 工具分布 审批时效聚合仪表盘 满意度全终态收集 与任务成功分开表述 source 口径排除评测会话
- **政策 RAG** 关键词预筛加 LLM 精排两级检索 19 篇政策语料 检索只辅助解释 终判留在确定性引擎
- **断点恢复** 工作流逐步存档 模型调用无状态可重放 进程中断后从事件重建续跑
- **两级评测** L1 脚本化回归（111 条 零成本 CI 门禁）+ L2 用户模拟（τ²-bench 范式 Haiku 扮演客户与真实模型多轮对话 三层判定）
- **离线可复现** 脚本化模型加冻结时钟 无密钥无外部依赖 L1 全链路可跑可测

## 快速开始

环境要求 Node 20+ pnpm 10+

```bash
pnpm install
pnpm db:reset        # 重置数据库并载入演示数据
pnpm dev             # 启动 API http://localhost:8787
pnpm dev:web         # 启动工作台 http://localhost:8790 (另开终端)
```

演示令牌

| 身份      | 令牌             |
| --------- | ---------------- |
| 客户 张伟 | cust-token-1001  |
| 客户 李娜 | cust-token-1002  |
| 售后专员  | operator-token   |
| 主管 审批 | supervisor-token |

未配置 ANTHROPIC_API_KEY 时对话能力返回 503 审批 运行记录 评测看板不受影响

## 常用命令

```bash
pnpm test            # 全部单元与契约测试
pnpm typecheck       # 类型检查
pnpm lint            # 静态检查
pnpm eval            # L1 脚本化回归 单轮 111 条 零成本
pnpm eval -- --repeat 3     # L1 三轮 输出 Pass^3
pnpm eval:sim        # L2 用户模拟评测 P0 全量 需要密钥
pnpm eval:sim -- --repeat 3       # L2 三轮 Pass^3
pnpm eval:sim -- --case <id>      # 单用例调试
pnpm demo            # 终端离线演示 五个核心场景
pnpm eval:dataset    # 导出评测数据集 JSON
pnpm db:reset        # 重置数据库
pnpm build           # 构建前端生产包
```

## 接入真实模型

```bash
cp .env.example .env
# 填入 ANTHROPIC_API_KEY 可选调整 ANTHROPIC_MODEL
# 用代理或中转站时同时设置 ANTHROPIC_BASE_URL 指向自定义地址
```

配置后工作台对话走原生 tool calling 真流式
L2 评测用 Haiku 扮演客户与被测模型多轮对话 模拟器与被测模型强制分离

## 评测结果

两级分层 模拟器成绩与真实模型成绩分开表述 诚实原则不混算

| 层级 | 指标 | 当前值 |
| ---- | ---- | ------ |
| L1 脚本化（治理回归） | 任务成功率 | 111/111 |
| L1 脚本化（治理回归） | P0 门禁 | 通过 |
| L2 用户模拟（真实模型） | 任务成功率 | 33/105 31.4% 报告 evr_11d079d1（功能 14 前的 105 条用例集 人工接管用例尚未跑 L2） |

说明 L1 证明运行时与治理层正确性 L2 补上智能层成绩
L2 数字为 deepseek-v4-pro 全量单轮实测 Wilson 95% [23.3% 40.8%]
其中 13 条为代理 503 环境异常 剔除后模型行为口径 35.9%
两者必须分开表述 详见 [数字诚实声明](docs/interview/STAR.md)

## 目录结构

```text
packages/
  contracts/     共享契约 枚举 状态迁移表 事件协议 工具契约 评测 Schema
  domain/        纯领域层 实体 状态机 政策引擎 领域服务 仓储接口
  persistence/   SQLite 仓储实现 事件存储 业务夹具
  tools/         工具注册表 故障注入执行器 Mock 支付网关
  workflow/      确定性工作流引擎 审批 断点 租约
  agent/         原生 Agent 循环 tool-defs 上下文管理 Anthropic 与脚本化适配器
  runtime/       组合根 评测与 API 共用装配
  eval/          评测运行器 用户模拟器 judge 三层判定 111 条用例数据集
apps/
  api/           Hono HTTP 服务 REST SSE 审批 运营端点 人工接管 满意度与分析
  web/           Next.js 会话工作台 坐席工作台 审批中心 运营分析 运行详情 评测看板
scripts/         演示 重置 数据集导出
docs/            架构 业务背景 评测方法论 ADR 面试叙事
infra/           PostgreSQL DDL Docker Compose 生产路径
```

## 文档索引

- [架构设计](docs/architecture.md) 分层图 生命周期 退款安全链 事件协议
- [业务背景](docs/business-context.md) 为什么做售后 Agent 人机分工边界
- [术语表](docs/CONTEXT.md) 补偿与物流推送业务概念 词汇一致
- [评测方法论](docs/evaluation.md) 用例契约 指标定义 Pass^k Badcase 回流
- [架构决策记录](docs/adr/DECISIONS.md) 十一条关键决策与备选方案
- [面试叙事](docs/interview/STAR.md) STAR 结构与高频追问 附 [ADR-004 追问稿](docs/interview/adr004-defense.md) 为什么不用 Mastra 与 MCP
- [组件开发规范](apps/web/CONVENTIONS.md) 前端组件约定
- [局限性](LIMITATIONS.md) 诚实边界

## API 一览

```text
POST /api/runs                              创建售后会话
POST /api/runs/:id/messages                 补问答复
POST /api/runs/:id/resume                   断点恢复 操作员
POST /api/runs/:id/approvals/:aid/decide    审批决定 主管
POST /api/runs/:id/logistics-events         物流事件注入 操作员
GET  /api/runs/:id/events                   SSE 事件流 Last-Event-ID 补发
GET  /api/runs/:id/events/json              事件 JSON 查询
GET  /api/approvals                         待审批列表
POST /api/operations/receive-goods          确认收货 操作员
GET  /api/eval/reports                      评测报告
POST /api/eval/run                          触发评测套件
GET  /api/health                            健康检查
```

## 技术栈

TypeScript strict pnpm workspace Hono Next.js 15 React 19 Tailwind 4
better-sqlite3 Zod Vitest ESLint Prettier @anthropic-ai/sdk 可选

## License

MIT
