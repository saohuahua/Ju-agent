# AfterSales Copilot 可评测 可恢复的电商售后 Agent 平台

面向退换货 退款与补偿流程的业务 Agent 系统 覆盖多轮澄清 政策判定 人工审批 幂等退款
断点恢复与两级回归评测 核心命题是 **让 Agent 在有副作用的业务里安全工作 并能用数据证明它做对了**

不是客服聊天机器人 副作用治理与评测闭环才是这个项目的主体

## 操作手册

[完整操作手册](docs/manual/README.md)按业务人员、管理员、开发运维三个目录组织，包含真实页面截图、完整退款演练和可复制接口示例。[评测操作专章](docs/manual/devops/evaluation.md)说明当前离线 L1/L2、指标分母、Judge、失败排查与报告比较；当前命令和数据集以该章及实际源码为准。复现完整审批与退货流程可运行 `node --import tsx docs/manual/devops/demo.ts`，使用独立临时双库，不默认 build。

## 学习与当前实现入口

2026-09-28 新增半自动售后引导：普通咨询连续追问、快捷说明、意图补问选项及可实际受理的人工入口；退款办理中通过关联咨询联系人工。已使用用户配置的 DeepSeek 完成有限真实模型及浏览器验收，旧快照保留原行为。启用方式、测试与费用边界见[售后引导交接](docs/handoffs/customer-guidance.md)。

2026-09-28 客户消息与处理进度已修复：SSE 禁止代理压缩缓冲，默认持久智能会话发送即回显并按请求键确认，回复与订单选择卡片可恢复，进度只展示可核验动作。根因、接口兼容和验收范围见[消息与进度交接](docs/handoffs/customer-message-progress.md)。

2026-09-28 新增最近订单查询与选单：默认 simulation 新会话无需手填订单号，可选择本人最近订单及商品，保留原始退货诉求，并识别“无法开机”等质量问题表述。旧会话保留冻结版本，需要新建咨询体验。实现、测试和已知边界见[最近订单选单交接](docs/handoffs/recent-order-selection.md)。

完整材料从[导学：有据售后](docs/learning/导学-有据售后.md)开始，原 22 章按主题分层，新增[10 篇业务详解](docs/learning/03-业务逻辑详解/README.md)、10 张业务 SVG、[23 道业务练习与独立解析](docs/learning/09-练习与自测/业务流程练习.md)，建议先业务后机制阅读；[面经](docs/interview/面经-有据售后.md)提供主问与递进追问，配套[重建练习](docs/learning/09-练习与自测/渐进重建练习.md)、[技术自测](docs/learning/09-练习与自测/集中自测.md)和[证据索引](docs/learning/维护与证据/核心结论与证据索引.md)。精确复现命令见[本地离线演示](docs/runbooks/p11-local-offline-demo.md)，无需重复构建。

当前默认持久入口使用完整模型轮次确认、冻结版本工具集合和字符政策检索；旧版逐 token 事件、动态查单门控及上下文压缩不能直接视为此入口已启用能力。两类退款通过业务授权、发送意图和原交易查询恢复，未知资金不自动重发。P8 双分支调查为独立模块，未接默认客户入口。真实模型、真实支付及 Docker 运行验收的限制见[当前证据索引](docs/learning/维护与证据/核心结论与证据索引.md)。

## 历史能力与实验背景

以下保留早期路径的能力描述与实验线索，不作为当前默认入口的功能清单。部分旧措辞包含强结论，引用前应核对具体源码、实验条件和上述现行说明；尤其不能把历史真实模型百分比作为当前质量，或将模拟资金防重写成全局绝对保证。

- **原生 Agent 循环** 模型经原生 tool calling 决策（tool_use 块 + 工具参数流式增量） ask_user 协议工具承接多轮澄清 旧 JSON 协议已废除
- **混合架构** 模型负责理解与决策 副作用路径固化为确定性工作流 资金动作永不直接经过模型
- **真流式** 文本与工具参数逐 token 落事件表 SSE 透传 断线补发 刷新重建
- **上下文工程** working memory 状态便签 + 最近消息 + 超限确定性压缩 压缩效果落 context.compacted 事件可量化
- **能力门控** 未查过订单前 业务动作工具不出现在模型的工具目录 结构性防盲提交 而非提示词恳求
- **副作用安全** 业务幂等键 一次性审批令牌 网关级去重三道防线 重复退款被结构性排除 拦截落 guard.blocked 事件可回放
- **安全分流（越权三分法）** 能力范围外拒绝收尾 / 纯注入攻击拒绝且升级且记审计 / 正当诉求外包攻击话术否掉话术照办 三类处置互不混淆 注入拦截落独立审计动作
- **现金红包补偿** 物流延误与服务道歉安抚 50 元分界分级 小额自动发放 大额人工审批 同订单同原因仅一次
- **价保流程** 签收后 7 天窗口 SKU 明细差价全额退 大额走人工审批 同一订单仅可价保一次
- **物流事件推送** 运营注入物流状态变化 空闲会话即达即触达主动告知 忙时挂起下一轮 已签收订单拒绝回退
- **L2 提示词迭代闭环** 失败归因（悬停 误升级 解释不全 工具可见性）→ 三轮定向修复（conclude 判断标准 拒绝不升级 补偿触发 工具重试 范围歧义先确认）→ 全量重跑验证 任务成功率 31.4% → 52.3% get_order 补售后历史 工具参数断言 contains 语义匹配
- **人工接管闭环** escalated 不再是死终态 坐席工作台接管（handling_human）双向对话 标记解决回 completed 权限分离 AI 不碰终审 坐席不碰执行
- **运营分析 + CSAT** 会话量 解决率 升级率 工具分布 审批时效聚合仪表盘 满意度全终态收集 与任务成功分开表述 source 口径排除评测会话
- **政策 RAG** 关键词预筛加 LLM 精排两级检索 19 篇政策语料 检索只辅助解释 终判留在确定性引擎
- **断点恢复** 工作流逐步存档 模型调用无状态可重放 进程中断后从事件重建续跑
- **两级评测** L1 脚本化回归（124 条 零成本 CI 门禁）+ L2 用户模拟（τ²-bench 范式 Haiku 扮演客户与真实模型多轮对话 三层判定）
- **离线可复现** 脚本化模型加冻结时钟 无密钥无外部依赖 L1 全链路可跑可测

## 快速开始

默认部署入口为根目录 `compose.yaml`，显式离线 simulation，无需模型密钥。需要可用的本机 Docker Engine 和 Compose v2。当前机器容器运行验收受阻，配置交付不等于容器实测通过。完整命令与边界见 [离线部署手册](docs/runbooks/offline-deployment.md)。

```bash
docker compose --env-file infra/docker/offline.env -p youju-p10 -f compose.yaml build
docker compose --env-file infra/docker/offline.env -p youju-p10 -f compose.yaml up -d --wait
```

浏览器访问 `http://127.0.0.1:18790/workbench`。默认不会占用原 8787/8790 服务，业务和渠道分别持久化。普通重启不运行 db:reset 或删除卷。镜像首次构建需要依赖下载或已有缓存，离线指运行期间不调用真实模型和资金，并非首次构建无需网络。

本地离线开发只需运行 `pnpm dev:offline`，再打开终端打印的工作台地址。此入口与 Compose 使用相同的 simulation 业务模式和内嵌模拟渠道，网页同样经 `/api` 代理到 API；数据保存在独立的 `data/local-offline/`，不会读取 Docker 卷或原 `data/app.db`。完整用法与差异见[本地与容器一致性](docs/runbooks/local-offline.md)。旧的 `pnpm dev` / `pnpm dev:web` 保留为分别启动的开发入口，不自动启用完整离线业务。部署工具链固定 Node 22.23.2 与 pnpm 11.23.0，按锁文件安装。`infra/docker/docker-compose.yml` 仅保留历史 PostgreSQL/Redis 设施，当前运行时没有迁移到 PostgreSQL。

换电脑保留当前本地数据时，先停止服务，运行 `pnpm data:backup:offline`，将打印的备份目录带到新电脑，在首次启动前运行 `pnpm data:restore:offline <备份目录>`。备份包含业务库和模拟渠道库，操作步骤见[本地与容器一致性](docs/runbooks/local-offline.md)。不迁移历史数据时，直接运行 `pnpm dev:offline` 会创建表和基础演示数据。

演示令牌

| 身份      | 令牌             |
| --------- | ---------------- |
| 客户 张伟 | cust-token-1001  |
| 客户 李娜 | cust-token-1002  |
| 售后专员  | operator-token   |
| 主管 审批 | supervisor-token |

这些令牌仅用于本机离线演示，不是生产认证方案。业务与支付仍固定为 simulation；真实模型对话可在本机设置页经过连接测试后单独启用，见[模型设置手册](docs/runbooks/model-settings.md)。

## 常用命令

```bash
pnpm test            # 全部单元与契约测试
pnpm typecheck       # 类型检查
pnpm lint            # 静态检查
pnpm eval            # L1 脚本化回归 单轮 124 条 模拟成本
pnpm eval -- --repeat 3     # L1 三轮 输出 Pass^3
pnpm eval:sim        # L2 显式离线模拟入口 真实模式仍禁用
pnpm eval:sim -- --repeat 3       # L2 三轮 Pass^3
pnpm eval:sim -- --case <id>      # 单用例调试
pnpm demo            # 终端离线演示 五个核心场景
pnpm eval:dataset    # 导出评测数据集 JSON
pnpm db:reset        # 重置数据库
pnpm build           # 构建前端生产包
```

## 接入真实模型

本机设置页支持 Anthropic Messages 与 OpenAI 兼容 Chat 协议的真实模型对话。API Key 只保存在服务端进程内存，连接测试和对话均须显式启用；模型调用费用按用户填写的单价估算，不代表供应商账单。订单与支付继续模拟，真实业务生产部署、Judge 校准与模型质量验证仍未完成。配置步骤和边界见[模型设置手册](docs/runbooks/model-settings.md)。

以下旧 L2 成绩属于历史实验记录，不代表当前部署的真实模型质量。当前阶段事实以 [IMPLEMENTATION](IMPLEMENTATION.md) 和 [P10 交接](docs/handoffs/p10-offline-deployment.md) 为准。

## 评测结果

两级分层 模拟器成绩与真实模型成绩分开表述 诚实原则不混算

| 层级 | 指标 | 当前值 |
| ---- | ---- | ------ |
| L1 脚本化（治理回归） | 任务成功率 | **124/124**（安全段扩至 26 条） |
| L1 脚本化（治理回归） | P0 门禁 | 通过 |
| L2 用户模拟（真实模型） | 任务成功率 | 33/105 31.4%（v2 提示词 基线）→ **58/111 52.3%（v2.3 三轮迭代后）** 报告 evr_14b4a3c3 |
| L2 用户模拟（真实模型） | Pass^3 稳定性 | **35.1%**（p0×3 三轮全过）Pass@3 83.8% 报告 evr_fd2c9a2d |
| L2 用户模拟（安全段专项） | injection_defense | 1/13 7.7%（v2.3 回归）→ **9/25 36%（v2.4 安全分流首版）** → v2.5 三分法完整验证待中转站配额恢复 详见 LIMITATIONS |

说明 L1 证明运行时与治理层正确性 L2 补上智能层成绩
L2 基线为 v2 提示词 105 条用例集全量单轮 迭代终值为 v2.3 提示词 111 条用例集全量单轮
剔除代理 503 环境异常后模型行为口径 35.9% → 57.4% 提升约 21 个百分点
三轮 p0 迭代曲线 54.1% → 73.0% → 67.6% 安全段回归在 v4 由安全分流修复 v2.4 实测回升至 36% 环境剔除口径 39.1% 未达 40% 简单档 v2.5 完整 L2 验证因中转站 token 配额耗尽未完成 如实标注 详见 LIMITATIONS
两者必须分开表述 详见 [简历事实与数字边界](docs/interview/简历事实摘要.md)

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

- [P11 写作约定与章节规划](docs/learning/维护与证据/写作约定与章节规划.md) 已确认标准；22 章及配套材料从[导学](docs/learning/导学-有据售后.md)进入，检查范围见[编写与复核记录](docs/learning/维护与证据/编写与复核记录.md)
- [架构设计](docs/architecture.md) 分层图 生命周期 退款安全链 事件协议
- [业务背景](docs/business-context.md) 为什么做售后 Agent 人机分工边界
- [术语表](docs/CONTEXT.md) 补偿与物流推送业务概念 词汇一致
- [评测方法论](docs/evaluation.md) 用例契约 指标定义 Pass^k Badcase 回流
- [架构决策记录](docs/adr/DECISIONS.md) 十一条关键决策与备选方案
- [面试材料入口](docs/interview/README.md) 项目面经、40 题映射与简历事实；框架和 MCP 取舍见现行面经 Q21–Q22
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
