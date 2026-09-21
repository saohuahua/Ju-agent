# Redesign 审计文档（阶段 0 产出）

> 本文档是 AfterSales Copilot 前端重设计的总依据，由阶段 0 审计产生。
> 后续阶段（阶段 1-4）的每一次改动都必须遵守本文档的「问题清单」与「功能红线」。
> 审计范围：apps/web 全部页面与组件（只读审计），审计日期：2026-09-21。

---

## 一、审计结论（诊断摘要）

当前 UI 是典型的「暗色 console 风格 AI 工具默认审美」：全站深色 slate 底、高饱和实底状态色、无设计 token 体系、无 focus-visible / loading 状态、圆角与字体全站不一致。这与产品定位「可评测、可恢复、可审计的治理型售后 Agent」严重不符，也与重设计定调（暖白浅色、editorial、克制）相反。

诊断分类：

- **A 类（主题与设计系统）**：9 条，全站性，阶段 0 已解决（globals.css / layout.tsx）。
- **B 类（交互状态缺失）**：6 条，阶段 0 解决 AppShell 与共享组件部分，页面部分在阶段 1-4 逐页落地。
- **C 类（组件模式问题）**：10 条，阶段 0 解决共享组件（StatusBadge / ToolCard / ApprovalCard），页面级在后续阶段。
- **D 类（排版与文案）**：4 条，标题模式阶段 0 定下，页面落地在后续阶段。
- **E 类（布局与 a11y）**：3 条。

三旋钮定调：VARIANCE 5 / MOTION 3 / DENSITY 4（数据密集页 5-6）。全站浅色主题锁定，无暗色模式（内部工作台，light-only 由定调决定）。

---

## 二、当前 UI 问题清单（逐条带文件与行号）

### A. 主题与设计系统

| # | 问题 | 位置 | 说明与处置 |
| --- | --- | --- | --- |
| A1 | 全站暗色 console 主题 | [layout.tsx:12](../../apps/web/src/app/layout.tsx#L12) `bg-slate-950 text-slate-100`；[globals.css:4](../../apps/web/src/app/globals.css#L4) `color-scheme: dark` | AI 工具默认审美。阶段 0 切换为暖白浅色（stone 系）。 |
| A2 | 无设计 token 体系 | [globals.css:1-21](../../apps/web/src/app/globals.css#L1) 仅滚动条样式 | 颜色、圆角、边框、字距全部硬编码在各组件。阶段 0 在 globals.css 以 Tailwind v4 `@theme` 建立 token。 |
| A3 | 圆角无体系 | rounded-md/lg/2xl/full 混用：[AppShell.tsx:49](../../apps/web/src/components/AppShell.tsx#L49)、[workbench/page.tsx:122,134,166,189,194](../../apps/web/src/app/workbench/page.tsx#L122)、[approvals/page.tsx:70,77,102,109](../../apps/web/src/app/approvals/page.tsx#L70)、[runs/page.tsx:36](../../apps/web/src/app/runs/page.tsx#L36)、[runs/[runId]/page.tsx:90,98,135](../../apps/web/src/app/runs/[runId]/page.tsx#L90)、[eval/page.tsx:101,126,153,171](../../apps/web/src/app/eval/page.tsx#L101)、[StatusBadge.tsx:24](../../apps/web/src/components/StatusBadge.tsx#L24)、[ToolCard.tsx:27](../../apps/web/src/components/ToolCard.tsx#L27)、[ApprovalCard.tsx:43,59,67](../../apps/web/src/components/ApprovalCard.tsx#L43) | 锁定为容器 10px / 控件 8px / 徽章 6px（token：rounded-container / rounded-control / rounded-badge）。 |
| A4 | 浏览器默认字体，无等宽统一 | [layout.tsx:11](../../apps/web/src/app/layout.tsx#L11) 未设 font-family | 阶段 0 在 globals.css 定义 --font-sans / --font-mono；数字与 ID 一律等宽或 tabular-nums。 |
| A5 | 金额无千分位且未用等宽 | [runReducer.ts:208-211](../../apps/web/src/lib/runReducer.ts#L208) 输出 `¥6999.00`；[approvals/page.tsx:82-84](../../apps/web/src/app/approvals/page.tsx#L82) 金额 span 非 mono | 硬约束要求 `¥12,345.67`。阶段 0 改 formatAmount 展示层并同步测试；金额一律 tabular-nums 或 font-mono。 |
| A6 | 高饱和实底状态徽章 | [StatusBadge.tsx:10-18](../../apps/web/src/components/StatusBadge.tsx#L10) 全部 `bg-*-600 text-white` | 阶段 0 改 muted pastel：浅底 + 深字 + 细边 pill。 |
| A7 | 主色 sky-600 高饱和且无全站锁定 | [AppShell.tsx:50](../../apps/web/src/components/AppShell.tsx#L50)、[workbench/page.tsx:136,189,194](../../apps/web/src/app/workbench/page.tsx#L136)、[eval/page.tsx:90](../../apps/web/src/app/eval/page.tsx#L90)、[runs/page.tsx:70](../../apps/web/src/app/runs/page.tsx#L70) | 阶段 0 锁定唯一低饱和主色 sage（自定义 token），全站禁用蓝紫渐变。 |
| A8 | 暗色滚动条硬编码 | [globals.css:8-20](../../apps/web/src/app/globals.css#L8) | 阶段 0 随浅色主题重写。 |
| A9 | 错误条暗色底 | [workbench/page.tsx:166-168](../../apps/web/src/app/workbench/page.tsx#L166)、[approvals/page.tsx:64-66](../../apps/web/src/app/approvals/page.tsx#L64)、[runs/page.tsx:32-34](../../apps/web/src/app/runs/page.tsx#L32)、[runs/[runId]/page.tsx:118-120](../../apps/web/src/app/runs/[runId]/page.tsx#L118)、[eval/page.tsx:96-98](../../apps/web/src/app/eval/page.tsx#L96) | 阶段 0 换浅色 red-50 底 + red-700 字；后续阶段考虑抽 ErrorBanner 共享组件。 |

### B. 交互状态缺失

| # | 问题 | 位置 | 说明与处置 |
| --- | --- | --- | --- |
| B1 | 全部按钮/链接无 focus-visible 样式 | [AppShell.tsx:46-54,63-70](../../apps/web/src/components/AppShell.tsx#L46)、[workbench/page.tsx:84-93,119-126,191-197](../../apps/web/src/app/workbench/page.tsx#L84)、[approvals/page.tsx:99-112](../../apps/web/src/app/approvals/page.tsx#L99)、[runs/page.tsx:68-73](../../apps/web/src/app/runs/page.tsx#L68)、[runs/[runId]/page.tsx:86-94](../../apps/web/src/app/runs/[runId]/page.tsx#L86)、[eval/page.tsx:87-93](../../apps/web/src/app/eval/page.tsx#L87) | 键盘可达性硬伤。阶段 0 建立全局 focus-visible 规则（globals.css），组件级不写 outline-none。 |
| B2 | 无 :active 按压反馈 | 同上各处按钮 | 阶段 0 起全部交互控件加 `active:scale-[0.98]`（200-300ms 过渡）。 |
| B3 | 无 loading 状态，首屏闪现空状态 | [approvals/page.tsx:69-73](../../apps/web/src/app/approvals/page.tsx#L69)、[runs/page.tsx:49-55](../../apps/web/src/app/runs/page.tsx#L49)、[eval/page.tsx:100-104](../../apps/web/src/app/eval/page.tsx#L100) | 列表首次加载时直接渲染「暂无…」。后续阶段加骨架屏（匹配最终布局形状，禁用通用 spinner）。 |
| B4 | 侧边栏导航无 aria-current、active 高饱和实底 | [AppShell.tsx:46-54](../../apps/web/src/components/AppShell.tsx#L46) | 阶段 0 加 aria-current="page"；active = 主色浅底 + 墨字 + 左侧 2px 主色竖条。 |
| B5 | transition 不统一 | [AppShell.tsx:49](../../apps/web/src/components/AppShell.tsx#L49) 有 transition-colors；[approvals/page.tsx:99-112](../../apps/web/src/app/approvals/page.tsx#L99) 决定按钮无 transition | 全站统一 200-300ms CSS 过渡，遵守 prefers-reduced-motion（globals.css 兜底）。 |
| B6 | 表格行 hover 无过渡 | [runs/page.tsx:57](../../apps/web/src/app/runs/page.tsx#L57)、[runs/[runId]/page.tsx:146](../../apps/web/src/app/runs/[runId]/page.tsx#L146) | 后续阶段补 transition-colors。 |

### C. 组件模式问题

| # | 问题 | 位置 | 说明与处置 |
| --- | --- | --- | --- |
| C1 | 导航 active 用高饱和实底 | [AppShell.tsx:50](../../apps/web/src/components/AppShell.tsx#L50) | 阶段 0 重构（见 B4）。 |
| C2 | 身份切换 select 为浏览器默认样式，无 focus-visible | [AppShell.tsx:60-70](../../apps/web/src/components/AppShell.tsx#L60) | 阶段 0 只换样式，onChange 逻辑不动。 |
| C3 | 空状态仅文字，无图标无引导 | [approvals/page.tsx:70-72](../../apps/web/src/app/approvals/page.tsx#L70)、[runs/page.tsx:50-53](../../apps/web/src/app/runs/page.tsx#L50)、[eval/page.tsx:101-103](../../apps/web/src/app/eval/page.tsx#L101)、[workbench/page.tsx:106-112](../../apps/web/src/app/workbench/page.tsx#L106) | 后续阶段补 phosphor 图标 + 引导文案的空状态组件。 |
| C4 | 表格容器 overflow-hidden，窄屏截断而非滚动 | [runs/page.tsx:36](../../apps/web/src/app/runs/page.tsx#L36)、[runs/[runId]/page.tsx:135](../../apps/web/src/app/runs/[runId]/page.tsx#L135) | 后续阶段改 overflow-x-auto。 |
| C5 | 「详情 →」使用箭头字符 | [runs/page.tsx:72](../../apps/web/src/app/runs/page.tsx#L72) | 阶段 0 换 phosphor ArrowRight 图标。 |
| C6 | 消息气泡 rounded-2xl 与圆角体系冲突、用户气泡高饱和 | [workbench/page.tsx:134-136](../../apps/web/src/app/workbench/page.tsx#L134) | 阶段 0 用户气泡改主色 sage 深底白字；圆角改容器级。 |
| C7 | 无 skip-link、无焦点管理 | 全站 | 后续阶段加 hidden skip-link（a11y）。 |
| C8 | SSE 连接状态仅文字颜色区分 | [workbench/page.tsx:80-82](../../apps/web/src/app/workbench/page.tsx#L80) | 阶段 1 加语义点（已连接 emerald / 重连中 amber）。 |
| C9 | 评测指标表未展示 passPowerK | [types.ts:62](../../apps/web/src/lib/types.ts#L62) 有字段，[eval/page.tsx](../../apps/web/src/app/eval/page.tsx) 未引用 | 功能遗漏，属产品功能补充，非视觉任务，记录待产品确认。 |
| C10 | ApprovalCard 客户视角按钮区与主管视角复用同一组件 | [ApprovalCard.tsx:53-83](../../apps/web/src/components/ApprovalCard.tsx#L53) | 逻辑保持，后续阶段视觉分层。 |

### D. 排版与文案

| # | 问题 | 位置 | 说明与处置 |
| --- | --- | --- | --- |
| D1 | 页面标题模式不统一 | [approvals/page.tsx:60-63](../../apps/web/src/app/approvals/page.tsx#L60)、[runs/page.tsx:28-31](../../apps/web/src/app/runs/page.tsx#L28)、[eval/page.tsx:81-85](../../apps/web/src/app/eval/page.tsx#L81)、[runs/[runId]/page.tsx:80-85](../../apps/web/src/app/runs/[runId]/page.tsx#L80)、[workbench/page.tsx:70-75](../../apps/web/src/app/workbench/page.tsx#L70) | 全站统一：页面顶部「左对齐大标题 + 右侧一行副文本」，禁止居中。阶段 0 定模式并落地列表页；workbench 对话页副文本保留标题下方（对话布局例外，阶段 1 复核）。 |
| D2 | 标题字号偏小、层级不足 | 各页 h1 为 text-sm/text-lg | 页面大标题 tracking-tight + text-xl 起，正文层级靠字重与颜色。 |
| D3 | 文案缺标点 | [AppShell.tsx:72-74](../../apps/web/src/components/AppShell.tsx#L72)「演示环境令牌 生产环境应替换为正式认证」 | 阶段 0 改为「演示环境令牌，生产环境应替换为正式认证。」。 |
| D4 | 数字未 tabular-nums | 金额（approvals）、指标（eval MetricTile）、表格时间列 | 后续阶段全局统一 tabular-nums 或 font-mono。 |

### E. 布局与 a11y

| # | 问题 | 位置 | 说明与处置 |
| --- | --- | --- | --- |
| E1 | workbench 用 h-screen | [workbench/page.tsx:68](../../apps/web/src/app/workbench/page.tsx#L68) | 阶段 0 改 `h-[100dvh]`（桌面等价，移动端视口稳定）。 |
| E2 | 无 z-index 体系 | 全站目前无 z 使用 | 后续引入弹层时建立 z 常量，禁止任意 z-9999。 |
| E3 | 全局滚动条样式影响可访问性 | [globals.css:8-20](../../apps/web/src/app/globals.css#L8) | 阶段 0 重写为浅色细滚动条，保留 8px 宽度。 |

---

## 三、功能红线清单（不可改动项）

以下文件与逻辑只允许视觉与标记结构改动，禁止改动任何业务逻辑、状态语义、接口契约。

| 红线 | 文件 | 不可改内容 | 允许的改动 |
| --- | --- | --- | --- |
| R1 | [apps/web/src/lib/sse.ts](../../apps/web/src/lib/sse.ts) | `useRunEvents` 全部逻辑：EventSource 连接、查询参数令牌注入、事件名注册、断线重连、状态归约调用 | 无（本阶段及后续阶段都不动此文件） |
| R2 | [apps/web/src/lib/runReducer.ts](../../apps/web/src/lib/runReducer.ts) | `reduceEvent` / `reduceEvents` / `initialViewState` 的归约语义与 `RunViewState` 形状；事件序号去重规则；状态机迁移 | `formatAmount` 仅允许展示格式调整（分转元语义不变），测试同步更新 |
| R3 | [apps/web/src/lib/api.ts](../../apps/web/src/lib/api.ts) | `api` 对象全部方法签名、请求路径、Authorization 注入、ApiError 构造；`DEMO_TOKENS` 四个选项的 label 与 value；`TOKEN_STORAGE_KEY` | 注释与格式 |
| R4 | [apps/web/src/components/AppShell.tsx](../../apps/web/src/components/AppShell.tsx) | `switchToken` / `currentToken` / `setToken` 调用链；select 的 value/onChange 绑定；NAV_ITEMS 的 href 路径 | 样式、图标、aria 属性、可见文案的标点与格式 |
| R5 | [apps/api/src/auth.ts](../../apps/api/src/auth.ts) | 令牌映射 cust-token-1001/1002/1003、operator-token、supervisor-token | 无（服务端，本任务不触碰） |
| R6 | [apps/web/src/lib/types.ts](../../apps/web/src/lib/types.ts) | 全部类型字段，与 packages/contracts 的契约一致 | 无 |
| R7 | [apps/web/test/runReducer.test.ts](../../apps/web/test/runReducer.test.ts) | 归约行为断言 | 仅当 formatAmount 展示格式调整时同步金额期望值 |

### 全局硬约束（所有阶段）

1. 可见文案禁止 em-dash（— / –）与感叹号结尾；金额格式 `¥12,345.67`。
2. 图标统一 `@phosphor-icons/react`，禁止手写 SVG path；图标库已在本阶段安装。
3. 动效只用 200-300ms CSS 过渡（hover/active/状态切换），全部遵守 prefers-reduced-motion，不装动效库。
4. 每阶段结束必须 `pnpm --filter web typecheck` 与 `pnpm --filter web test` 通过。
5. 单一主色 sage 全站锁定；语义状态色 muted pastel 化：浅底 + 深字（进行中 sky / 成功 emerald / 失败 red / 等待 amber / 升级 purple / 审批 orange）。

---

## 四、阶段 0 确立的设计系统（后续阶段遵守）

### 4.1 色彩 token（Tailwind v4 @theme，globals.css）

- 底色 canvas `#faf9f7`（暖白）；表面 surface `#ffffff`；墨色 ink `#1c1917`（stone-900）；hairline 边框 `#e7e5e4`。
- 主色 sage 系（唯一低饱和交互色，全站锁定）：sage-50 `#f4f7f4` / sage-100 `#e7eee7` / sage-200 `#d0ddd1` / sage-300 `#aec4b0` / sage-400 `#86a489` / sage-500 `#64876a` / sage-600 `#4c6c53` / sage-700 `#3d5743` / sage-800 `#334738` / sage-900 `#2b3b2f`。按钮实底 sage-700 白字，hover sage-800。
- 状态色全部 muted pastel：`{色}-50` 底 + `{色}-800` 字 + `{色}-200` 边（sky=进行中、emerald=成功、red=失败、amber=等待、purple=升级、orange=审批），中性 stone-100 底 + stone-600 字。
- 禁止渐变、重阴影（阴影仅在悬浮层级使用且 < 0.05 透明度）、纯黑纯白大块面。

### 4.2 圆角体系

容器 10px（rounded-container）/ 控件 8px（rounded-control）/ 徽章 6px（rounded-badge），全站锁定，禁止 rounded-full 用于大容器（状态 pill 徽章例外，用 rounded-badge 的非全圆 pill）。

### 4.3 排版纪律

- 页面大标题：tracking-tight，左对齐，禁居中。
- 小标签：11px、宽字距（每页最多 1 处）。
- 数字与 ID：一律等宽或 tabular-nums。
- 中文字体栈：system-ui + PingFang SC / Microsoft YaHei；等宽栈：ui-monospace + Cascadia Code / Consolas。

### 4.4 标题模式（全站强制）

页面顶部 = 左对齐大标题 + 右侧一行副文本（text-sm text-stone-500），禁止居中。有操作按钮的页面（eval、运行详情）按钮与副文本同排居右。对话页（workbench）副文本保留标题下方，为唯一例外。

### 4.5 交互状态

- 全部交互控件：hover 背景/色相位移 + active `scale(0.98)` + focus-visible 可见焦点环（全局规则，组件禁写 outline-none），过渡 200-300ms。
- loading 用骨架屏匹配最终布局；empty 用虚线边框 + 图标 + 引导文案；error 用红色浅底条。
- 全部动效尊重 prefers-reduced-motion（globals.css 全局兜底）。

### 4.6 AppShell 规范

暖白侧边栏 + hairline 右边框；品牌区「AfterSales Copilot」+ 副标题「可评测 · 可恢复的售后 Agent」；四个导航项各配一枚 phosphor 图标；active = sage-50 浅底 + 墨字 + 左侧 2px sage 竖条 + aria-current="page"；hover、focus-visible 齐全。身份切换 select 逻辑不动。

---

## 五、阶段规划映射（后续阶段遵守本文档）

| 阶段 | 范围 | 本文档对应条目 |
| --- | --- | --- |
| 1 | 会话工作台 | A9、B2/B3、C3、C6、C8、D1 例外复核、E1 已完成 |
| 2 | 审批中心 | A5 等宽、B2/B3、C3 |
| 3 | 运行记录 + 运行详情 | B6、C4、C5 已完成、D1 |
| 4 | 评测看板 | A5、B3、C3、C9（待产品确认） |
| 各阶段 | 组件收尾 | C7 skip-link、E2 z-index 体系、ErrorBanner 共享组件 |
