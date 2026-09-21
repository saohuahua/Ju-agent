# v2 Part 1 UI 前端设计规格（面 1-5）

> 本文件是 v2 升级 Part 1（UI 前端设计）的产出，设计先行，代码后做。
> 每个「面」流程：设计 skill 审计 → 静态 HTML 原型 → 用户确认 → 写入本规格。
> 实现阶段（Part 2）按本规格开发，前端改动遵守 docs/redesign-audit.md 设计系统。
> 原型统一存放 docs/v2-ui-mockups/，本地预览 http://localhost:8990/（`pnpm` 无，用 `python -m http.server 8990 --directory docs/v2-ui-mockups`，已配 .claude/launch.json mockups）。

## 全局色板（v2 升级版，已确认 2026-09-21）

v2 Part 1 起全站色板升级为「纯白 + 电光蓝」，替代阶段 0 的「暖白 stone + sage」（修订记录见 docs/redesign-audit.md 开头）。本规格内所有面的原型与实现都使用以下 token：

| token | 值 | 用途 |
| --- | --- | --- |
| canvas / surface | `#ffffff` | 页面底色与卡片表面，纯白 |
| ink | `#18181b`（zinc-900） | 正文墨色 |
| hairline | `#e5e7eb`（zinc-200） | 细边框 |
| zinc-50 `#fafafa` / zinc-400 `#a1a1aa` / zinc-500 `#71717a` / zinc-600 `#52525b` / zinc-300 `#d4d4d8` | - | hover 底 / 弱化文本 / 次级文本 / 说明文本 / 虚线禁用 |
| blue-50 `#eff6ff` ~ blue-800 `#1e40af` | - | 唯一主色：blue-600 `#2563eb` 按钮实底白字（对比 5.16:1），hover blue-700；blue-50 浅底 + blue-800 深字做选中/徽章 |
| 语义状态色 | muted pastel 不变 | 浅底 + 深字 + 细边：sky=进行中、emerald=成功、red=失败、amber=等待、purple=升级、orange=审批 |

圆角（容器 10px / 控件 8px / 徽章 6px）、密度（数据页 5-6）、动效（200-300ms + prefers-reduced-motion）、phosphor 图标、禁 em-dash 等规则不变。

---

## 面 1 评测看板升级

原型：[docs/v2-ui-mockups/01-eval-dashboard.html](../v2-ui-mockups/01-eval-dashboard.html)，预览 http://localhost:8990/01-eval-dashboard.html
状态：已确认 2026-09-21（配色经用户反馈调整两轮后定稿）

### 1. 设计假设（已确认 2026-09-21）

1. **失败 kind 到判定四层映射**：state→状态层，trajectory→轨迹层，args→参数层，communicate/judge→回复质量层，escalation/clarify→轨迹层，gateway→状态层（扣款次数），simulator→用户模拟器自身失败，单独标注、不计入被测模型成绩。
2. **契约/schema 扩展前置**：`EvalCaseResult.failures` 现为 `string[]`，需扩展为结构化 `{kind, message}[]`（kind 取自 packages/eval validators 的 AssertionFailure.kind 九种），packages/contracts 同步；Wilson 置信区间字段需加入 EvalReport schema（依赖 W2.2）。
3. **改进显著性自动对比**：取最近两份 L2 报告画重叠区间，措辞「区间重叠，改进不显著」/「区间不重叠，改进显著」。
4. **Wilson 区间仅 L2 展示**：L1 为确定性回放，展示「无采样方差，不计算置信区间」说明，不画区间。

### 2. 页面结构

AppShell 侧边栏（评测看板 active，blue-50 浅底 + 左侧 2px blue-600 竖条）+ 页头（左标题「评测看板」+ 右副文本「脚本 L1 与真实模型 L2 的成绩分开展示，每个数字标注来源与模型。」）+ 原型声明条 + 七个区块：

1. 运行评测：L1 行 + L2 表单
2. 报告对比：L1/L2 双列 + 改进显著性条 + 诚实声明行
3. 分层指标：判定四层 + 原三组指标
4. 分类结果：八类风险面网格
5. 失败用例明细：表格 + 可展开失败面板
6. 模拟对话开销：仅 L2 报告
7. 历史报告：L1/L2 混合表格

### 3. 组件清单

| 组件 | 规格 |
| --- | --- |
| badge-l1 | zinc 中性：`#e4e4e7` 边 + `#fafafa` 底 + zinc-600 字「L1 脚本化回归」 |
| badge-l2 | blue：blue-200 边 + blue-50 底 + blue-800 字「L2 用户模拟」 |
| 运行评测面板 | 上下两行，hairline 分隔；每行左标题（名称 + 说明）、中表单、右操作按钮 |
| L1 行 | 说明「ScriptedModel 回放理想轨迹，约 2 秒完成」+「零成本，每次提交 CI 门禁。证明运行时与治理层正确性，不代表模型能力。」+ 次按钮「运行 L1 回归」 |
| L2 行 | 抽样 seg（P0 全量/P1 抽样/P2 抽样/全部）、轮数 seg（1 轮/3 轮）、三个 mono 输入（被测 Agent / 用户模拟器 / Judge 模型名）、成本估算「P0 全量 3 轮约 17 条用例，估算约 6.4 万 token」、主按钮「启动 L2 模拟评测」 |
| seg | hairline 边 + 白底，active = blue-100 底 + blue-800 字，hover blue-50 |
| input-mono | hairline 边 + 8px 圆角 + 等宽字体，模型名全量展示不截断 |
| btn-primary | blue-600 实底白字，hover blue-700，active scale(0.98) |
| btn-secondary | hairline 边白底 zinc-700 字，hover blue-50 |
| 对比列 | 徽章 + 报告 id/模型/时间 meta + 大数字通过率（40px 600 字重）+ 通过数/总数 + Pass^k 区 + 门禁行 |
| CI 区间条 | 自绘：0-100% 轴 + 区间矩形 + 均值圆点 + 刻度标签；primary blue-300 条 + blue-700 点，secondary zinc-300 条 + zinc-500 点；附「40 条样本下区间较宽，32 条规模时更宽，报告同步标注样本量。」 |
| 改进显著性条 | 同一轴两条重叠区间 + 图例（zinc-500 上份 / blue-700 最新，各带报告 id 与区间值）+ 判定徽章「区间重叠，改进不显著」+ 解释「两区间相交时不能断言成功率有真实提升，需要更多样本或更大效应。」 |
| 诚实声明行 | 信息图标 + 一行说明「L1 的 100% 是脚本化模型的确定性回放，证明系统层正确性。真实模型成绩以 L2 为准，两类数字分开表述。」 |
| 分层指标 | 四行：层名（状态/轨迹/参数/回复质量）+ 判定方式说明 + 通过率；下方保留正确性/安全治理/恢复协同三组指标 |
| 分类卡片 | 通过 = emerald pastel（浅底深字），有失败 = orange pastel；数字 22px 600 |
| 失败明细表 | 列：用例/优先级/轮次/Agent token/结果/明细；失败用例结果 badge-fail「失败 N 项」，通过 badge-pass |
| 展开面板 | details 展开箭头旋转 200ms；面板内按判定层分组（fg-title），每条失败 fail-item 带 kind 徽章（state/trajectory/args/judge 等 9 种）+ 断言消息；judge 条带「判据 + 理由」两行；底部失败导出路径 `eval/failures/{caseId}_{timestamp}.json`（含场景与完整 transcript，可人工归因后回流为回归用例）+ 运行回放链接（跳运行详情时间线） |
| 开销区 | 六格：平均轮次 / Agent token / 模拟器 token / 成本合计 / 用户模拟器模型 / Judge 模型 |
| 历史表 | 列：报告/来源（badge-l1 或 badge-l2）/模型/通过率/Pass^3/门禁/时间 |

### 4. 状态与交互

- **idle**：默认态，两个运行按钮可用。
- **key-warn（无密钥）**：amber 浅底条「未配置 ANTHROPIC_API_KEY，L2 用户模拟评测不可用，L1 脚本回归不受影响。诚实原则：不输出模拟成绩。」，L2 启动按钮禁用，L1 可用。
- **progress（运行中）**：sky 浅底条 + 呼吸圆点（1.6s pulse，prefers-reduced-motion 下静止）+「L2 第 2/3 轮 · 用例 12/17 · 当前 sim_refund_impatient · 已用 3 分 42 秒」。
- 全部按钮 hover 色位移 + active scale(0.98) + focus-visible 焦点环；表格行 hover `#fafafa`；数字一律 tabular-nums。
- 全页禁 em-dash；「Pass^3 稳定性」「Pass@3 能力上限」两词成对出现，不单独出现一个。

### 5. 数据前置项（实现阶段需先补契约/端点）

1. `packages/contracts/src/eval.ts`：EvalReport 加 Wilson CI 字段（W2.2 同步）；EvalCaseResult.failures 从 `string[]` 改 `{kind, message}[]`。
2. `apps/web/src/lib/api.ts`：目前只有 listEvalReports + runEval（L1），需加 L2 触发端点与运行状态轮询。
3. 历史表数据源需能区分 L1/L2 来源与 Pass^3 字段（types.ts 已有 passPowerK 未展示，属 C9 欠账）。

---

## 面 2 工作台物流推送时间线

（待设计：审计 → 原型 → 用户确认 → 写入本规格）

## 面 3 审批中心补偿审批卡片

（待设计）

## 面 4 价保流程入口与结果展示

（待设计）

## 面 5 政策 RAG 引用展示

（待设计）
