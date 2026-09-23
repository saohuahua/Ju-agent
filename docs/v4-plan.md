# v4 升级计划 深度可见化 产品闭环 安全回归修复

> 决策日期 2026-09-23 依据 grilling 共识会话（逐项核查代码库 + 浏览器实跑现有 UI 取证）
> 总目标 让已有深度在前端可见 补齐产品闭环 修复安全回归
> 第一目标 **产品完整度**（用户口径：完整产品本身就是最好的面试素材）
> 执行方式 vibe coding 分会话执行 每个功能新开对话 上下文干净

---

## 零、给执行 AI 的快速接入说明

**先读这一节 再读全文。**

### 这是什么项目

AfterSales Copilot 电商售后 Agent 平台。核心命题是**让 Agent 在有副作用的业务里安全工作 并能用数据证明它做对了**。不是客服聊天机器人 副作用治理与评测闭环才是主体。

### 技术底座（不要改动的部分）

- pnpm monorepo 八包两应用 TypeScript strict
- `packages/contracts` 共享契约（Zod schema 枚举 状态迁移表 事件协议）—— **所有跨层改动从这里起步**
- `packages/domain` 纯领域层 无 IO 依赖 服务在 `src/services/`
- `packages/persistence` SQLite 仓储实现 schema 在 `src/schema.ts`
- `packages/agent` 原生 tool calling 循环 `agent.ts` `context.ts` `tool-defs.ts` `prompt.ts`
- `packages/eval` L1 脚本化 111 条 + L2 用户模拟 τ²-bench 范式
- `apps/api` Hono 路由全在 `src/app.ts` SSE 在 `src/sse.ts`
- `apps/web` Next.js 15 App Router React 19 Tailwind 4

### 六层推进顺序（项目既定工作法 必须遵守）

> 语义确认 → 契约 → 领域 → 持久 → API/Agent → 评测 → UI

新术语必须沉淀到 `docs/CONTEXT.md`。跨层改动**禁止**从 UI 倒着写。

### 本版绝对不做的事（已有 ADR 明确记录 推翻会被面试追问）

- **不加多 Agent**。`docs/adr/DECISIONS.md` 已记录：Anthropic 官方指出共享上下文任务不适合拆分。
- **不加 MCP 层**。`docs/interview/adr004-defense.md` 是专门的"为什么不用 Mastra 与 MCP"追问稿。
- **不推翻确定性工作流边界**。资金动作永不直接经过模型 这是项目主叙事。

### 诚实原则（项目既定纪律）

- 脚本化模型（L1）成绩只证明系统层正确性 真实模型（L2）成绩必须分开表述 永不混算
- 新增能力若未经评测验证 必须写进 `LIMITATIONS.md` 而不是在 README 里声称
- 数字造假一票否决

---

## 一、共识决策记录

| # | 决策 | 结论 | 理由摘要 |
| --- | --- | --- | --- |
| D1 | 问题诊断 | 不是缺功能 是**功能不可见 + 布局不喜欢** | 仓库 24.5k 行 17 工具 111 用例 客观不薄；但深度在 UI 上零可见度 |
| D2 | 第一目标 | 产品完整度 | 用户口径：完整产品就是最好的面试素材 |
| D3 | 时间预算 | 1-2 周 vibe coding 不按人工估 | 唯一硬约束是 L2 评测墙钟时间（见 §七） |
| D4 | 视觉方向 | **混合双轨**：前台浅色 后台深色控制台 | 前台安抚客户 后台暴露真相 本身是可讲的设计决策 |
| D5 | 首屏 | 合一：hero + 实时数据 | 「数字是活的」——官网说服力 + 仪表盘真实性 |
| D6 | 导航 | 收成四组（总览/客户侧/运营侧/工程侧） | 分组本身在讲「有前台后台工程面的完整系统」 |
| D7 | 动效 | 落地页级滚动动画 | Framer Motion 承载 尊重 prefers-reduced-motion |
| D8 | 前端范围 | 三页重做 + 其他对齐 | 首屏（新建）会话工作台 运行详情 三页重做 其余按新设计系统对齐 |
| D9 | 深度可视化 | **四个载体全做** | 决策轨迹时间轴 / 工具门控面板 / 三道防线拦截 / 上下文窗口 |
| D10 | 业务功能 | **四个全做** | 客户自助中心 / AI 辅助起草 / 成本 token 可观测 / 政策管理后台 |
| D11 | 新颖点 | 对抗沙箱 + Trace 时间旅行回放 | 两者都基于已有事件表与断点恢复 不违背任何 ADR |
| D12 | 安全回归 | **修 当作本版一等功能** | injection_defense 40%→7.7% 修好了就多一条「评测体系拓住了我自己引入的回归」的叙事 |
| D13 | 多 Agent / MCP | 不加 守住 ADR | 为「新颖」推翻自己的架构决策 面试里是减分项 |
| D14 | 依赖策略 | 引入 Framer Motion + Recharts | 放弃「零新依赖」叙事 换开发效率；自绘 SVG 组件保留做特殊图 |
| D15 | 深色范围 | 后台固定深色 前台固定浅色 不做用户切换 | 前后台一眼分得出来 即设计意图 |
| D16 | 落盘方式 | 新建 docs/v4-plan.md | 沿用每轮迭代成文计划的工程习惯 |

---

## 二、现状基线（代码事实 执行时不必重新探索）

### 已落地功能（v1-v3 共 16 项）

原生 tool calling 循环 / 上下文三段式管理 / 能力门控 / 幂等三道防线 / 断点恢复 / 现金红包补偿 / 价保流程 / 物流事件推送 / 政策 RAG / 人工接管闭环 / 运营分析 + CSAT / L1 111 条 / L2 用户模拟 / 提示词三轮迭代

### 代码体量

| 包 | 行数 |
| --- | --- |
| packages/eval | 7888 |
| apps/web | 4287 |
| packages/domain | 3775 |
| packages/persistence | 2515 |
| packages/agent | 1645 |
| packages/contracts | 1467 |
| apps/api | 1021 |
| packages/tools | 900 |
| packages/workflow | 779 |

### Agent 工具清单（17 个）

读工具 `get_order` `get_shipment` `get_policy` `search_policy` `lookup_customer`
动作工具 `create_return_request` `cancel_return_request` `execute_refund` `create_compensation` `execute_compensation` `create_price_protection` `execute_price_protection` `record_return_shipment` `receive_return_goods` `escalate_to_human`
协议工具 `ask_user` `conclude`

门控逻辑在 `packages/agent/src/tool-defs.ts`：`ACTION_TOOLS` 常量 + `buildStepTools({ actions })`，未查过订单前动作工具不进工具目录。

### 事件类型（25 种 `packages/contracts/src/enums.ts:139`）

```
run.started / message.user / message.delta / message.completed
agent.output / agent.turn / agent.tool_results / tool.input.delta
context.compacted / step.started / step.completed
tool.requested / tool.completed
approval.required / approval.decided
run.paused / run.resumed / run.failed / run.completed / run.escalated
logistics.event / run.handover / operator.message / run.resolved
```

### 数据表（21 张 `packages/persistence/src/schema.ts`）

业务 `customers` `orders` `shipments` `return_requests` `refunds` `compensations` `price_protections` `sku_prices` `policy_articles` `policies` `approval_requests`
运行 `agent_runs` `agent_events` `tool_executions` `checkpoints` `ratings`
基础设施 `idempotency_records` `counters` `leases` `audit_logs` `eval_reports`

### 领域服务（11 个 `packages/domain/src/services/`）

`after-sale-service` `analytics-service` `approval-service` `audit-service` `compensation-service` `handover-service` `logistics-event-service` `policy-search-service` `price-protection-service` `rating-service` `run-service`

### API 路由（23 条 `apps/api/src/app.ts`）

```
GET  /api/health
POST /api/runs                                   GET  /api/runs            GET /api/runs/:runId
POST /api/runs/:runId/messages                   POST /api/runs/:runId/resume
POST /api/runs/:runId/handover                   POST /api/runs/:runId/operator-messages
POST /api/runs/:runId/resolve
POST /api/runs/:runId/rating                     GET  /api/runs/:runId/rating
GET  /api/runs/:runId/events (SSE)               GET  /api/runs/:runId/events/json
GET  /api/analytics/overview
GET  /api/approvals                              POST /api/runs/:runId/approvals/:approvalId/decide
POST /api/runs/:runId/logistics-events           POST /api/operations/receive-goods
GET  /api/eval/reports                           POST /api/eval/run
POST /api/eval/run-sim                           GET  /api/eval/sim-tasks/:taskId
```

### 前端现状（问题所在）

| 页面 | 行数 | 布局约束 | 问题 |
| --- | --- | --- | --- |
| `app/page.tsx` | 5 | — | 只有跳转 没有首屏 |
| `app/workbench/page.tsx` | 353 | `max-w-xl` 空状态 / `max-w-2xl` 气泡 | 第一印象等同任意 ChatGPT 套壳 |
| `app/console/page.tsx` | 354 | `max-w-2xl` | 坐席工作台 |
| `app/approvals/page.tsx` | 183 | `mx-auto max-w-4xl` | 单列 |
| `app/analytics/page.tsx` | 304 | `mx-auto max-w-5xl` | 单列 |
| `app/runs/page.tsx` | 126 | `mx-auto max-w-5xl` | 单列 |
| `app/runs/[runId]/page.tsx` | 348 | `mx-auto max-w-4xl` | 深度全埋在这 但是堆叠卡片 + 表格 |
| `app/eval/page.tsx` | 1201 | `mx-auto max-w-5xl` | 单页过大 需拆组件 |

**取证结论**：`AppShell` 给了 main 全宽（1216px @1440 屏），但每页自己收窄回 `max-w-4xl/5xl` 并居中，左右大片空白，且**全站没有任何一屏是多栏的**。设计系统（`apps/web/src/app/globals.css`）写的是"极简 editorial 浅色 暖白 monochrome sage 单一主色 hairline 细边"，`color-scheme: light` 写死。

---

## 三、阶段总览与依赖

```
阶段 0  地基（设计系统双轨 + 依赖 + 导航重构）        ← 一切的前置
   │
   ├─ 阶段 S  安全回归修复 + L2 验证                  ← 立即并行启动（墙钟长）
   │
   ├─ 阶段 A  深度可视化四件套                        ← 依赖 0
   │     └─ 阶段 E1  Trace 时间旅行回放               ← 依赖 A.1
   │
   ├─ 阶段 B  首屏驾驶舱                              ← 依赖 0 + C.3(成本可观测)
   │
   └─ 阶段 C  业务功能四件套                          ← 依赖 0
         └─ 阶段 E2  对抗沙箱                         ← 依赖 A.3 + S
```

**关键排期约束**：阶段 S（安全修复）的墙钟时间不受 vibe coding 加速，**必须第一天就启动**，与其他阶段并行推进。

### 裁剪顺序（时间被压缩时从后往前裁）

`E2 对抗沙箱` → `C.4 政策管理后台` → `E1 Trace 回放` → `C.1 客户自助中心` → `A.4 上下文窗口`
**永不裁**：阶段 0、阶段 S、A.1 决策轨迹、A.2 工具门控、阶段 B 首屏

---

## 四、阶段 0：地基

### 0.1 依赖引入

```bash
pnpm --filter web add framer-motion recharts
```

引入后**必须**在 `docs/adr/DECISIONS.md` 追加一条 ADR：记录从"零新依赖"转为"受控引入"的理由（落地页级动效与图表手写成本过高 用效率换克制）与边界（只在 `apps/web` 使用 后端包保持零新依赖）。不写 ADR 会在面试中被抓成前后矛盾。

### 0.2 设计系统双轨

改 `apps/web/src/app/globals.css`。**保留现有全部浅色 token**（前台继续用），新增深色控制台 token。

设计原则：**同一色相 两个面**。控制台不是"另一个品牌"，是 sage 色相的深色面。这样前后台一眼分得出来 但仍是一个产品。

```css
@theme {
  /* ===== 控制台深色轨（后台专用） ===== */
  --color-console-canvas: #0d100e;    /* 页面底 近黑带绿调 */
  --color-console-surface: #151a17;   /* 面板 */
  --color-console-raised: #1d2420;    /* 浮起卡片 / hover */
  --color-console-hairline: #2a322d;  /* 细边 */
  --color-console-ink: #e6eae7;       /* 主文本 */
  --color-console-muted: #8b948d;     /* 次要文本 */
  --color-console-dim: #5c655f;       /* 三级文本 / 禁用 */

  /* 深色下主交互色提亮到 sage-400 保证对比度 */
  --color-console-accent: #86a489;
  --color-console-accent-dim: #4c6c53;

  /* 状态色深色版（深底 + 亮字） */
  --color-console-ok: #6ee7a8;
  --color-console-warn: #f5c563;
  --color-console-danger: #f78a8a;
  --color-console-info: #7fb4e8;
}
```

**无障碍硬要求**：所有深色组合必须过 WCAG AA（正文 4.5:1 大字 3:1）。`--color-console-muted` 对 `--color-console-surface` 实测后若不达标必须提亮。

**实现方式**：后台页面根节点加 `data-theme="console"`，用 `[data-theme='console']` 作用域覆盖，不要用 Tailwind `dark:` 变体（那是用户偏好语义 这里是区域语义）。

### 0.3 导航重构成四组

改 `apps/web/src/components/AppShell.tsx`（当前 `NAV_ITEMS` 是平铺六项）。

| 组 | 页面 | 主题 |
| --- | --- | --- |
| **总览** | `/`（新建 驾驶舱） | 深色 |
| **客户侧** | `/workbench` 会话工作台、`/my`（新建 我的售后单） | **浅色** |
| **运营侧** | `/console` 坐席、`/approvals` 审批、`/analytics` 分析、`/policies`（新建 政策管理） | 深色 |
| **工程侧** | `/runs` 运行记录、`/eval` 评测看板、`/sandbox`（新建 对抗沙箱） | 深色 |

分组标题用小号字母间距拉开的 label，组间用 hairline 分隔。侧边栏本身在深色下呈现（它属于外壳）；进入 `/workbench` `/my` 时主区域切浅色，侧栏保持深色——**深浅交界本身就是"前台/后台"的视觉证据**。

### 0.4 验收

- 简单：`pnpm dev:web` 起得来 六个旧页面不报错 导航按四组渲染
- 完整：深色 token 全部生效 `/workbench` 仍是浅色 交界处视觉自然 `pnpm build` 通过
- 复杂：深色所有文本组合过 WCAG AA（给出实测对比度表）`prefers-reduced-motion` 下动效降级 键盘焦点环在深浅两轨都可见

---

## 五、阶段 S：安全回归修复（第一天启动 与其他阶段并行）

### 背景（必读）

`LIMITATIONS.md:17` 记录：提示词 v2.2 把越权处理从"拒绝并升级"改成"视为无效按正常流程"，导致 `injection_defense` 从 40% 掉到 7.7%，安全段 13 条只过 1 条。而 `README.md` 把 Prompt Injection 纵深防御写成核心能力。**这是当前项目最大的单点风险**。

### 根因假设（`v3-plan` 已定位）

攻击与正当诉求没有分流规则。v2.2 为了修"拒绝路径误升级"（正当但不予满足的诉求被错误升级），把越权一律降级处理，误伤了纯攻击场景。

### 做什么

1. **契约层**：在 `packages/contracts` 明确区分两类越权
   - `out_of_scope`：正当诉求但超出本 Agent 能力范围 → 正常拒绝 不升级
   - `injection_attempt`：试图篡改系统指令 / 越权提权 / 诱导绕过审批 → 拒绝 **且** 升级 **且** 记审计
2. **提示词层**：`packages/agent/src/prompt.ts` 升 `PROMPT_VERSION` 到 `v2.4`，加入分流判据。判据必须**可操作**（给出识别信号清单），不能只写"识别攻击"。
3. **系统层**：越权识别不能只靠提示词。检查 `packages/tools/src/executor.ts` 与 `packages/agent/src/agent.ts`，确保权限白名单在工具执行层仍然硬拦（提示词只是第一道 不是唯一一道）。
4. **审计层**：`injection_attempt` 必须落 `audit_logs`，前端可查（供阶段 E2 对抗沙箱展示）。

### 评测

- 先跑 `pnpm eval` 确认 L1 111 条不回归
- 再跑 `pnpm eval:sim -- --case <sec 用例 id>` 单例快验证
- 安全段专项：`pnpm eval:sim` 筛 `injection_defense` 分段
- 最后全量 + `--repeat 3` 出 Pass^3

**安全用例扩充**：当前只有 13 条，`LIMITATIONS.md:33` 自承"没有对抗性模糊测试集"。本轮至少扩到 **25 条**，覆盖：指令覆盖、角色扮演诱导、编码绕过、多轮渐进提权、伪造系统消息、诱导跳过审批、跨客户越权查单。

### 验收

- 简单：`injection_defense` 分段回到 ≥ 40%（基线水平）
- 完整：≥ 60% 且 L1 111 条无回归 P0 门禁通过
- 复杂：≥ 70% 且扩充后的 25 条安全集 Pass^3 ≥ 50% 修复前后曲线落进 `docs/` 可用于叙事

### 诚实要求

修复后必须更新 `README.md` 评测结果表与 `LIMITATIONS.md`。若未达到简单档，**不允许**在 README 声称已修复，如实写明当前水位。

---

## 六、阶段 A：深度可视化四件套

这是解决用户核心痛点（"功能很多 前端看不出来"）的主战场。**四个载体全部复用已有事件数据 不需要新的业务逻辑**。

### A.1 Agent 决策轨迹时间轴

**放哪**：`/runs/[runId]` 重做的主体（当前 348 行 堆叠卡片 + 表格）。

**画什么**：把一次 run 的事件流渲染成横向泳道时间轴。

```
时间 →
┌ 模型思考 ──┐                    ┌ 模型思考 ─┐
│            └ tool.requested ──┐ │           └ conclude
│                    get_order  │ │
│                               └─┘ tool.completed (142ms)
└ message.delta 流式文本
```

每个节点可点开看：完整入参（`tool.input.delta` 拼接出的流式过程）、返回值、耗时、token、是否失败重试。

**数据来源**：`GET /api/runs/:runId/events/json` 已经返回全部事件。前端按 `step.started`/`step.completed` 分组，`tool.requested`/`tool.completed` 配对，`message.delta` 聚合。

**新增 API**：无。纯前端消费已有数据。

### A.2 工具目录 + 能力门控实时状态

**放哪**：`/runs/[runId]` 右侧常驻面板 + `/workbench` 可折叠侧栏。

**画什么**：17 个工具画成网格，每个标注三态——

- **可见**（当前在模型的工具目录里）
- **门控中**（存在但因未满足前置条件不暴露给模型）
- **已调用**（本轮用过 显示次数）

当模型调 `get_order` 成功后，动作工具从"门控中"翻转成"可见"——**这个翻转动画是整个项目最值钱的一帧**，它把"能力门控 结构性防盲提交"从一句文案变成看得见的机制。

**数据来源**：`packages/agent/src/tool-defs.ts` 的 `ACTION_TOOLS` + `buildStepTools({ actions })`。

**需要新增**：当前工具目录的计算发生在 agent 内部 未落事件。需在 `packages/contracts/src/enums.ts` 加事件类型 `tools.catalog_changed`，payload 含 `{ visible: string[], gated: string[], reason: string }`，在 agent 每轮构建工具目录时发出。**这是本阶段唯一的契约改动 必须走六层顺序。**

### A.3 副作用三道防线拦截展示

**放哪**：`/runs/[runId]` 独立区块 + 驾驶舱聚合计数。

**画什么**：三道防线（业务幂等键 / 一次性审批令牌 / 网关级去重）画成串联的闸门。正常请求穿过三道闸；被拦截的请求在对应闸门亮红并展开说明"第 2 次退款请求被幂等键 `xxx` 拦截 未产生资金动作"。

**数据来源**：`idempotency_records` 表、`approval_requests` 表、`packages/tools/src/payment-gateway.ts` 的去重逻辑。

**需要新增**：拦截事件当前可能只在日志里。需确认三处拦截点都落 `audit_logs` 或新增事件类型 `guard.blocked`，payload `{ layer: 'idempotency'|'approval_token'|'gateway', key: string, action: string }`。

### A.4 上下文窗口实时可视化

**放哪**：`/runs/[runId]` 可展开面板。

**画什么**：一条横向容量条，分三段染色——working memory（状态便签）/ 最近消息 / 已压缩历史。`context.compacted` 事件触发时播放压缩动画并标注"压缩前 X tokens → 压缩后 Y tokens 策略 tool_result_clearing"。

**数据来源**：`context.compacted` 事件（`packages/contracts/src/events.ts:76`）**payload 已含 `strategy` `beforeTokens` `afterTokens` 三个字段 无需改动**。段落占比从 `packages/agent/src/context.ts` 的 `estimateTokens()` `buildWorkingMemory()` `clearOldToolResults()` 派生。

**需要新增**：若要展示三段（working memory / 最近消息 / 已压缩历史）各自的 token 占比，需给 payload 补 `segments: { workingMemory: number, recent: number, compacted: number }`。这是可选增强——不加也能做出容量条 只是分段是前端估算而非后端实测。**建议加**，理由是"上下文工程可量化"是项目卖点，估算值撑不住这个说法。

### 阶段 A 验收

- 简单：四个面板在 `/runs/[runId]` 都能渲染 数据非空
- 完整：工具门控翻转有动画 三道防线拦截能复现（手工触发重复退款）上下文压缩能触发并展示
- 复杂：四个面板在真实模型跑的会话上全部正确 且 L1 脚本化会话（无密钥）也能展示 时间轴节点可点开看流式入参逐帧

---

## 七、阶段 B：首屏驾驶舱

**路由**：`/`（当前只有 5 行跳转 直接替换）

### 结构

**第一屏 hero（满高）**

- 一句话定位：可评测 可恢复的电商售后 Agent 平台
- 一行副标题：让 Agent 在有副作用的业务里安全工作 并能用数据证明它做对了
- 四个大数字，**全部实时从 API 拉取 不写死**：
  - 累计会话数 / 解决率（`GET /api/analytics/overview`）
  - L1 门禁 111/111、L2 任务成功率（`GET /api/eval/reports` 取最新）
  - 累计拦截高风险动作次数（阶段 A.3 的 `guard.blocked` 聚合）
  - Agent 工具数 17 / 评测用例数（动态读取 不是硬编码）
- 数字用 Framer Motion 做递增动画 + 滚动进入触发

**「数字是活的」是本项目首屏的核心创意**：访客看到的不是营销文案里的静态数字，是此刻真实系统的读数。页面上要明确标注数据时间戳与来源端点，让人知道它是活的。

**第二屏 系统全貌**

架构分层图（可复用 `docs/architecture-diagrams.md` 的内容重绘为交互式）。悬停某层高亮并显示该层职责与代码位置。

**第三屏 实时驾驶舱**

真正的运营盘：活跃会话列表（SSE 实时）、待审批队列、今日工具调用分布、最近拦截记录、L1/L2 成绩曲线（Recharts）。

**第四屏 能力矩阵 + 入口**

16 项已落地能力做成网格，每项链到对应的演示页面。

### 动效规范

- 滚动进入用 Framer Motion `whileInView` + `viewport={{ once: true }}`
- 视差克制：只用于 hero 背景 位移不超过 40px
- 所有动效必须在 `prefers-reduced-motion: reduce` 下降为瞬时（现有 `globals.css` 已有该纪律 继续遵守）
- 首屏 LCP 元素（大标题）**不做入场动画** 避免拖慢首屏指标

### 验收

- 简单：四屏能滚 数字从 API 拉到真实值
- 完整：滚动动画流畅 实时驾驶舱 SSE 有数据 Recharts 图表正常 `pnpm build` 通过
- 复杂：Lighthouse 性能 ≥ 85 无布局偏移（CLS < 0.1）reduced-motion 下全部降级 API 挂掉时数字优雅降级为"—"而不是报错

---

## 八、阶段 C：业务功能四件套

### C.1 客户自助中心 `/my`

**产品缺口**：当前客户只有一个聊天框，看不到自己提过什么单、进行到哪一步。真实售后产品这是标配。

**做什么**

- 我的售后单列表：退货单 / 退款 / 补偿 / 价保 四类聚合
- 单条详情用进度时间轴（申请 → 审核 → 寄回 → 收货 → 退款 → 完成）
- 每单可跳回产生它的会话（`agent_runs` 关联）
- **浅色主题**（属客户侧）

**六层改动**

- 契约：新增 `CustomerTicketView` 聚合视图 schema
- 领域：`after-sale-service` 加 `listCustomerTickets(customerId)`
- 持久：跨 `return_requests` `refunds` `compensations` `price_protections` 的聚合查询
- API：`GET /api/my/tickets` `GET /api/my/tickets/:id`（客户令牌鉴权 **必须校验归属** 防越权查他人单）
- 评测：加 L1 用例覆盖"客户查询自己的单"与"客户尝试查他人单被拒"
- UI：`/my` 页面

### C.2 AI 辅助起草（agent assist）

**产品缺口**：`LIMITATIONS.md:53` 自承"无 AI 辅助起草（agent assist 未做 契约无预留）"。已列 v4 候选。这是 Sierra / Decagon / Intercom 的标配，体现人机协同而非人机二选一。

**做什么**

坐席在 `/console` 接管会话后，右侧面板实时给出 AI 建议回复 + 依据（引用的政策条款 + 订单事实）。坐席可一键采纳、改写后发送、或忽略。

**关键设计约束（必须遵守 否则破坏既有权限分离叙事）**

- AI 只**起草文本** 不执行任何业务动作（权限分离：AI 不碰终审 坐席不碰执行 —— D7 决策）
- 建议必须附依据 不能是无出处的自由发挥
- 采纳/改写/忽略三种处置**必须落库**，这是未来做"坐席行为数据回流改进模型"的数据基础，也是面试里能讲的产品闭环

**六层改动**

- 契约：`AssistDraft` schema `{ draftId, runId, text, citations[], status: 'suggested'|'accepted'|'edited'|'dismissed' }`
- 持久：新增 `assist_drafts` 表
- API：`POST /api/runs/:runId/assist/draft` `POST /api/runs/:runId/assist/:draftId/feedback`
- Agent：复用现有 `ChatModel` 但用独立的起草提示词（不进主 Agent 循环 不污染主上下文）
- 评测：L1 加用例校验"起草不触发任何动作工具"
- UI：`/console` 右侧面板（深色）

### C.3 成本与 token 可观测

**产品缺口**：`LIMITATIONS.md:55` 自承"单 run 的 token 成本无落库来源"。这是生产系统必备，也是阶段 B 首屏数字的数据源之一。

**做什么**

每个 run 的 token 用量、耗时、估算成本落库并在多处展示。

**六层改动**

- 契约：`RunCost` schema `{ runId, inputTokens, outputTokens, cacheReadTokens, model, estimatedCostCny, durationMs }`
- 持久：`agent_runs` 表加列 或新增 `run_costs` 表（推荐后者 便于按步拆分）
- Agent：`packages/agent/src/anthropic-model.ts` 从 API 响应的 `usage` 字段取真实 token；`scripted-model.ts` 走估算（`context.ts` 已有 `estimateTokens()`）
- API：`GET /api/runs/:runId` 返回体加 cost 字段；`GET /api/analytics/overview` 加成本聚合
- UI：运行详情显示单次成本、分析页显示成本趋势、驾驶舱显示累计成本

**诚实要求**：脚本化模型的 token 是**估算值** 必须与真实模型的实测值分开标注 不能混算（沿用项目既有诚实纪律）。定价表需注明取数时间与来源。

### C.4 政策管理后台 `/policies`

**产品缺口**：v3 曾决定不做（D4 的 E 项）。本版做，让"确定性政策引擎"变成可运营的产品。

**做什么**

- 政策条款列表（`policy_articles` 19 篇 + `policies` 规则表）
- 可编辑规则参数。**当前这些阈值是 `packages/domain/src/policy.ts` 的模块级 `export const` 硬编码**，本功能的主要工作就是把它们抽成可配置：

  | 常量 | 当前值 | 含义 |
  | --- | --- | --- |
  | `NO_REASON_WINDOW_DAYS` | 7 | 七天无理由窗口 |
  | `PRICE_PROTECTION_WINDOW_DAYS` | 7 | 价保窗口 |
  | `LARGE_REFUND_THRESHOLD_CENTS` | 500_000（5000 元） | 大额退款人工审批阈值 |
  | 补偿自动发放阈值 | 5_000（50 元） | 小额自动发放 大额转审批 |

- 版本化：改动生成新版本 记录变更人与时间
- **不做灰度并行判定**（`LIMITATIONS.md:26` 已记录未实现 保持诚实 本版只做版本记录与切换）

**六层改动**

- 契约：`PolicyVersion` schema
- 领域：`policy.ts` 的规则判定需支持按版本号取参数（**当前是模块级 `export const` 硬编码 必须抽成注入式配置**，注意这会影响所有引用这些常量的测试与评测用例 改动面比看起来大）
- 持久：`policies` 表加版本列
- API：`GET/POST/PATCH /api/policies`（**主管令牌鉴权** 政策是高危配置）
- 评测：L1 加用例验证"改阈值后判定结果随之改变"
- UI：`/policies` 页面（深色）

### 阶段 C 验收

- 简单：四个功能各自能跑通主路径
- 完整：全部有 L1 用例覆盖 `pnpm eval` 111+ 条全绿 越权访问被正确拒绝
- 复杂：C.1 客户越权查单有专项用例；C.2 起草的动作工具隔离有用例证明；C.3 真实模型 token 与估算 token 分开展示；C.4 改政策后历史判定不被追溯篡改

---

## 九、阶段 E：两个新颖点

### E1 Trace 时间旅行回放（依赖 A.1）

**在 `/runs/[runId]` 的时间轴上加播放器控件**：播放/暂停/逐帧/拖拽进度条。

拖到任意时刻，页面所有面板同步回到那一刻的状态——工具目录当时有哪些可见、working memory 当时写了什么、上下文占用多少、已执行了哪些副作用。

**为什么这个可行且不违背 ADR**：项目本来就有"工作流逐步存档 模型调用无状态可重放 进程中断后从事件重建续跑"的断点恢复能力（`checkpoints` 表 + `rebuildMessages()`）。时间旅行只是**把已有的重建能力做成 UI**，不是新造轮子。

**实现**：纯前端。把事件按时间戳排序，维护一个 `cursor`，所有面板从 `events.slice(0, cursor)` 派生状态。`packages/agent/src/context.ts` 的 `rebuildMessages(events)` `buildWorkingMemory(events)` 是纯函数，**可以直接在前端复用**（需确认无 Node 依赖，若有则在 `apps/web/src/lib/` 做一份同构实现并加测试保证一致）。

**验收**
- 简单：能拖能播 时间轴游标动
- 完整：四个面板全部随游标同步回溯
- 复杂：回溯出的 working memory 与后端 `buildWorkingMemory()` 结果逐字节一致（加契约测试）

### E2 对抗沙箱 `/sandbox`（依赖 A.3 + 阶段 S）

**访客自己攻击这个 Agent**，实时看三道防线怎么拦。

**做什么**

- 提供一个输入框 + 一组预置攻击样本（指令覆盖 / 角色扮演 / 编码绕过 / 渐进提权 / 伪造系统消息 / 诱导跳过审批 / 跨客户越权）
- 提交后实时展示：模型怎么回应 → 系统层怎么判定 → 哪道防线拦了 → 审计记录长什么样
- 右侧常驻"防御机制说明"：每被触发一次就高亮对应机制
- 累计攻击尝试与拦截率统计（喂给首屏驾驶舱）

**为什么值钱**：把安全叙事从"我说我防了"变成"你自己试"。面试官会亲手输入攻击，这是整个项目最容易被记住的交互。同时它天然承接阶段 S 的修复成果——修好了才敢让人随便打。

**安全约束（重要）**

- 沙箱必须跑在**隔离的演示客户上下文**，不能触碰真实夹具数据的资金动作
- 必须有速率限制（防止沙箱被当免费 LLM 接口刷）
- 沙箱会话的 `source` 标记为 `sandbox`，**不计入运营分析口径**（沿用 v3 的 D13 决策：source 口径过滤）
- 无 API 密钥时优雅降级为"回放预录的攻防样本"，而不是报错

**验收**
- 简单：预置样本能跑 能看到拦截结果
- 完整：自由输入能跑 三道防线展示正确 sandbox 会话不污染 analytics
- 复杂：有速率限制 无密钥时回放降级可用 攻击成功（穿透）时也如实展示并记入 LIMITATIONS

---

## 十、硬约束与风险

### 不受 vibe coding 加速的部分

| 项 | 约束 |
| --- | --- |
| L2 评测全量跑 | 真实 API 调用 一轮几十分钟起 中转站 503 需重试 已有用例级重试 + 1.5s 节流 |
| Pass^3 | ×3 轮 时间三倍 |
| 安全段迭代 | 改提示词 → 跑 → 归因 → 再改 每循环至少一次全量 |

**结论**：阶段 S 第一天启动 与其他阶段完全并行。不要等 UI 做完再修安全。

### 已知风险

1. **深色/浅色双轨的一致性成本**。两套 token 意味着每个组件要验两遍。缓解：组件层不写死颜色 全部走 CSS 变量 由 `data-theme` 作用域决定。
2. **首屏实时数字的失败模式**。API 挂掉时首屏会很难看。缓解：所有实时数字必须有 loading 骨架与降级占位 不允许出现 `NaN` 或 `undefined`。
3. **`/eval` 单页 1201 行**。本版若要对齐新设计系统，建议先拆组件再改样式，否则改动风险高。这是技术债 不是新功能 但会拖慢阶段 0。
4. **契约改动的连锁**。A.2（`tools.catalog_changed`）、A.3（`guard.blocked`）、A.4（`context.compacted` 补字段）、C.3（`RunCost`）都动契约。**必须一次性设计完再动手**，避免反复迁移。建议阶段 0 结束时先把所有新事件类型与 schema 一次性定稿。
5. **Recharts 与深色主题**。Recharts 默认样式偏浅 需统一配置深色 theme。建议封一层 `apps/web/src/components/console-charts.tsx` 统一注入配色 不要每处单配。

### 诚实红线（违反即返工）

- 新能力未经评测验证 → 写 `LIMITATIONS.md` 不写 README
- L1 与 L2 成绩永不混算
- 脚本化估算 token 与真实 token 分开标注
- 安全修复未达标 → 如实写当前水位 不允许声称已修复
- 沙箱被攻穿 → 如实展示并记录 这比假装没被攻穿有说服力得多

---

## 十一、执行方式

### 分会话执行（项目既定惯例）

每个阶段（或每个功能）新开一个对话，上下文干净。开场给执行 AI 的话：

```
读 docs/v4-plan.md 的「零、给执行 AI 的快速接入说明」和「§X 阶段 X」
按六层顺序（契约 → 领域 → 持久 → API/Agent → 评测 → UI）实现
完成后跑 pnpm typecheck && pnpm test && pnpm eval
全绿后单 commit 提交 新术语沉淀到 docs/CONTEXT.md
```

### 每个功能的收口标准

```bash
pnpm typecheck        # 类型检查
pnpm lint             # 静态检查
pnpm test             # 单元与契约测试
pnpm eval             # L1 回归 111+ 条 零成本
pnpm build            # 前端生产构建
```

全绿才提交。涉及 Agent 行为改动的（阶段 S、C.2）额外跑 `pnpm eval:sim`。

### 提交规范

沿用现有格式：`feat(包名1,包名2): 功能N 一句话描述 关键数字`

例：`feat(contracts,agent,web): 功能21 工具目录与能力门控实时可视化 17 工具三态翻转`

### 文档同步

每个阶段完成后同步更新：
- `README.md` 核心能力清单与评测结果表
- `LIMITATIONS.md` 新增/消除的边界
- `docs/CONTEXT.md` 新术语
- `docs/adr/DECISIONS.md` 架构决策（阶段 0 的依赖引入必须写）
- `docs/interview/STAR.md` 新增可讲的叙事

---

## 十二、功能编号索引（接续 v3 的功能 17）

| 编号 | 功能 | 阶段 | 可裁 |
| --- | --- | --- | --- |
| 18 | 设计系统双轨 + 依赖引入 + 导航四组 | 0 | 否 |
| 19 | 安全回归修复 + 安全用例扩充至 25 条 | S | 否 |
| 20 | Agent 决策轨迹时间轴 | A.1 | 否 |
| 21 | 工具目录 + 能力门控实时状态 | A.2 | 否 |
| 22 | 副作用三道防线拦截展示 | A.3 | 是（末位） |
| 23 | 上下文窗口实时可视化 | A.4 | 是 |
| 24 | 首屏驾驶舱（hero + 实时数据） | B | 否 |
| 25 | 客户自助中心 /my | C.1 | 是 |
| 26 | AI 辅助起草 agent assist | C.2 | 是（末位） |
| 27 | 成本与 token 可观测 | C.3 | 否（B 依赖） |
| 28 | 政策管理后台 /policies | C.4 | 是 |
| 29 | Trace 时间旅行回放 | E1 | 是 |
| 30 | 对抗沙箱 /sandbox | E2 | 是（最先裁） |

**裁剪顺序**：30 → 28 → 29 → 25 → 23
**永不裁**：18 19 20 21 24 27
