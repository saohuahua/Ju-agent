# AfterSales Copilot 可评测 可恢复的电商售后 Agent 平台

面向退换货与退款流程的业务 Agent 系统 覆盖多轮澄清 政策判定 人工审批 幂等退款
断点恢复与离线回归评测 核心命题是 **让 Agent 在有副作用的业务里安全工作 并能用数据证明它做对了**

不是客服聊天机器人 副作用治理与评测闭环才是这个项目的主体

## 核心能力

- **混合架构** 模型负责理解与决策 副作用路径固化为确定性工作流 资金动作永不直接经过模型
- **副作用安全** 业务幂等键 一次性审批令牌 网关级去重三道防线 重复退款被结构性排除
- **事件溯源** 全链路 SSE 事件流 先落库再执行 断线补发 刷新重建
- **断点恢复** 工作流逐步存档 进程中断后恢复续跑 已完成步骤不重复执行
- **确定性评测** 32 条任务契约 以数据库终态 工具轨迹 网关扣款为准 P0 门禁阻断 CI
- **离线可复现** 脚本化模型加冻结时钟 无密钥无外部依赖 全链路可跑可测

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
pnpm eval            # 评测套件 单轮
pnpm eval -- --repeat 3   # 三轮 输出 Pass^3
pnpm demo            # 终端离线演示 五个核心场景
pnpm eval:dataset    # 导出评测数据集 JSON
pnpm db:reset        # 重置数据库
pnpm build           # 构建前端生产包
```

## 接入真实模型

```bash
cp .env.example .env
# 填入 ANTHROPIC_API_KEY 可选调整 ANTHROPIC_MODEL
```

配置后工作台对话走真实模型 评测可用 `pnpm eval -- --model anthropic` 测真实成绩
脚本化套件与真实模型共享同一套提示词与运行时

## 评测结果

脚本化模型下 系统正确性证明 见 [评测报告样例](eval/reports)

| 指标       | 当前值 |
| ---------- | ------ |
| 任务成功率 | 32/32  |
| P0 门禁    | 通过   |
| Pass^3     | 100%   |
| 重复副作用 | 0      |

说明 脚本化模型证明运行时与治理层正确性 真实模型成绩需配置密钥后另行评测
两者必须分开表述 详见 [数字诚实声明](docs/interview/STAR.md)

## 目录结构

```text
packages/
  contracts/     共享契约 枚举 状态迁移表 事件协议 工具契约 评测 Schema
  domain/        纯领域层 实体 状态机 政策引擎 领域服务 仓储接口
  persistence/   SQLite 仓储实现 事件存储 业务夹具
  tools/         工具注册表 故障注入执行器 Mock 支付网关
  workflow/      确定性工作流引擎 审批 断点 租约
  agent/         Agent 循环 ScriptedModel AnthropicModel 提示词
  runtime/       组合根 评测与 API 共用装配
  eval/          评测运行器 验证器 指标 32 条用例数据集
apps/
  api/           Hono HTTP 服务 REST SSE 审批 运营端点
  web/           Next.js 工作台 会话 审批中心 运行详情 评测看板
scripts/         演示 重置 数据集导出
docs/            架构 业务背景 评测方法论 ADR 面试叙事
infra/           PostgreSQL DDL Docker Compose 生产路径
```

## 文档索引

- [架构设计](docs/architecture.md) 分层图 生命周期 退款安全链 事件协议
- [业务背景](docs/business-context.md) 为什么做售后 Agent 人机分工边界
- [评测方法论](docs/evaluation.md) 用例契约 指标定义 Pass^k Badcase 回流
- [架构决策记录](docs/adr/DECISIONS.md) 十条关键决策与备选方案
- [面试叙事](docs/interview/STAR.md) STAR 结构与高频追问
- [组件开发规范](apps/web/CONVENTIONS.md) 前端组件约定
- [局限性](LIMITATIONS.md) 诚实边界

## API 一览

```text
POST /api/runs                              创建售后会话
POST /api/runs/:id/messages                 补问答复
POST /api/runs/:id/resume                   断点恢复 操作员
POST /api/runs/:id/approvals/:aid/decide    审批决定 主管
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
