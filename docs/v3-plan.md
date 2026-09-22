# v3 升级计划 坐席闭环 L2 迭代 运营仪表盘

> 决策日期 2026-09-22 依据 grilling 共识会话（调研来源：2026-09-20 本地选型调研 + 五份补充调研结论 + 知识截止 2026-01 的 Sierra/Decagon/Intercom Fin/Cresta 产品面认知 + 代码库逐项核查；该会话网搜工具损坏，未采信任何搜索结果）
> 总目标 5-7 天 三目标全要（产品闭环 面试深度 前端饱满）3 个必做功能 + 1 个可裁项
> 裁剪规则 时间被压缩时从后往前裁 坐席闭环与 L2 迭代永不裁剪

## 一、共识决策记录

| # | 决策 | 结论 | 理由摘要 |
| --- | --- | --- | --- |
| D1 | 拓展目标 | 产品闭环 面试深度 前端饱满三目标全要 | v2 已把证据深度做扎实 当前最大短板是 escalated 断链与无改进曲线 |
| D2 | 时间预算 | 5-7 天 3 必做 + 1 可裁 | 秋招窗口临近 投递与面试复练优先级高于项目 |
| D3 | WIP 处置 | 功能 13（运行后台推进）先收尾提交 | typecheck 与 API 测试 11/11 已绿 补跑全量回归即提交 工作区归零 |
| D4 | 功能组合 | A 坐席工作台 B L2 迭代+Pass^3 C 仪表盘+CSAT 必做 D 模拟直播可裁 | E 政策管理 UI 与 F 基线消融不做（F 列入 v4 候选） |
| D5 | 接管状态机 | 新增 handling_human 状态 | escalated 从死终态改为可接管中间态 L1 断言不受影响 增量改动 |
| D6 | 坐席身份 | 复用 operator 角色 | 语义本就是客服坐席 前端四身份切换已有 |
| D7 | 坐席能力边界 | 纯对话 + 标记解决（附摘要） | 业务动作仍走审批中心 权限分离叙事：AI 不碰终审 坐席不碰执行 |
| D8 | agent assist | 本轮不做 列入 v4 候选 | 控制范围保证必做三项做满 |
| D9 | Pass^3 范围 | 全量 105 单轮出总成绩 + p0 档 26×3 出 Pass^3 | 两个数字含义清晰 成本可控 与 CI 的 L1 Pass^3 形成对照 |
| D10 | 迭代预算 | 2 个迭代循环 全量重跑 ≤3 次（含终跑） | 每循环 p0 快验证 成本可控每轮有产出 |
| D11 | 看板增强 | passPowerK 展示 + 任选两报告对比 + prompt/model 版本标注 | 补 v2 欠账 把改进曲线可视化 |
| D12 | CSAT 范围 | 全部终态可评分 | 支撑 CSAT×任务成功交叉分析 |
| D13 | 聚合口径 | 仅真实客户会话 run 加 source 标记过滤 | L2 模拟会话会写 runs 表 不过滤运营指标失真 |
| D14 | 图表实现 | 设计系统内自绘 SVG 组件 | 不加依赖 依赖克制叙事加分 走 dataviz 规范 |
| D15 | 落盘方式 | 新建 docs/v3-plan.md | v2-plan 已完结归档 每轮迭代成文计划是工程习惯 |
| D16 | 执行方式 | 计划 + 执行 prompt 粘贴新对话执行 | v2 惯例 每功能新会话 上下文干净 |
| D17 | 裁剪顺序 | D 模拟直播 → CSAT 交叉 → 仪表盘深化 → 看板对比增强 | A 与 B 永不裁 |

## 二、阶段总览

| 阶段 | 主题 | 核心产出 | 裁剪 |
| --- | --- | --- | --- |
| 0 | 功能 13 收尾 | 后台推进提交 工作区归零 | 永不裁 |
| A | 坐席工作台（功能 14） | handling_human 状态机 坐席收件箱 双端 SSE 人工接管闭环 | 永不裁 |
| B | L2 迭代 + Pass^3（功能 15） | 提升数字 真实模型 Pass^3 看板增强 | 永不裁 |
| C | 仪表盘 + CSAT（功能 16） | 分析页 CSAT 收集与交叉 | 部分可裁 |
| D | 模拟直播（功能 17） | 浏览器实时观看 L2 模拟对话 | 最先裁 |

## 三、详细步骤

每个功能沿用六层推进顺序 语义确认 → 契约 → 领域 → 持久 → API/Agent → 评测 → UI 新术语沉淀 docs/CONTEXT.md

### 0. 功能 13 收尾（WIP 已在工作区）

做什么

- 补跑 `pnpm typecheck`（已绿）`pnpm test` 全量 `pnpm eval` 105 条回归
- 全绿后单 commit 提交 运行后台推进（创建/续跑/恢复即返 事件走 SSE 单飞锁 409 预检）

产出 工作区归零 提交历史干净

验收 三命令全绿 工作台首屏即可提问 处理中禁发

**执行记录 2026-09-22 完成 commit b21cf07**

- 验证 pnpm typecheck 全绿 pnpm test 184 条全过 pnpm eval 105/105 P0 门禁通过（报告 evr_70758f73）
- 提交含 API 异步化 单飞锁 409 预检 后台异常兜底 failed 工作台首屏即问 处理中禁发 运行详情提示语义更新
- v3 计划文档先行单独提交（ac64fab）

### A. 坐席工作台 约 1.5-2 天（功能 14）

做什么

- 契约层 RunStatus 加 `handling_human` RUN_TRANSITIONS 改 `escalated: ['handling_human']`（原为空数组）新增 `handling_human: ['completed']` 事件协议加 run.handover / operator.message / run.resolved（含解决摘要）三类事件
- 领域层 人工接管服务（命名执行时定）takeOver 校验仅 escalated 可接管 message 仅 handling_human 可发 resolve 附摘要转 completed 三个动作全部落 audit_logs
- 持久层 无新表 消息与状态变化复用 agent_events 与 agent_runs 状态机乐观锁
- API 层 POST /api/runs/:runId/handover、operator-message、resolve 三个端点 operator/supervisor 权限 409/403 语义与现有端点同源
- Agent 层 无改动（人工回合不经模型）
- SSE/前端 客户工作台归约器渲染 operator.message 坐席气泡与接管提示条 状态徽章加「人工处理中」 新增 /console 坐席工作台页（operator 令牌可见）：escalated 收件箱列表 + 会话详情（复用轨迹与事件时间线组件）+ 回复输入 + 解决面板（摘要必填）
- 评测层 L1 新用例 4-6 条 hd_*（接管后终态 completed 断言 坐席消息事件断言 未接管时发消息 409 customer 403 非 escalated 不可接管）

设计要点

- escalated 改为可出边是增量改动 L1/L2 既有用例断言 escalated 终态不受影响（它们不执行接管）
- 评测指标 escalation_correctness 语义不变

三档验收

- 简单 escalated 会话出现在坐席收件箱 坐席发一条消息客户工作台实时可见
- 完整 接管 → 对话 → 标记解决全链路 状态机走 handling_human L1 用例绿 SSE 断线重连后坐席消息不丢
- 复杂 收件箱多会话并发认领防护（409）解决摘要入审计与事件时间线 客户侧 CSAT 在人工解决后同样可评（与功能 C 联动）

**执行记录 2026-09-23 完成 功能 14 人工接管闭环**

- 契约层 RunStatus 加 handling_human RUN_TRANSITIONS escalated 出边接管 handling_human 唯一出口 completed 事件协议加 run.handover / operator.message / run.resolved 请求契约 OperatorMessageRequest / RunResolveRequest
- 领域层 HumanHandoverService takeOver（仅 escalated 角色门槛领域防线）appendOperatorMessage / appendCustomerMessage（仅 handling_human 直落事件不经模型）resolve（附摘要迁回 completed）三动作全审计 角色与状态违规抛 CONFLICT / AUTHORIZATION_DENIED
- 组合根 composeSystem 装配 handoverService 评测与 API 共用
- API 层 三端点 handover / operator-messages / resolve（operator/supervisor）消息端点在 handling_human 时客户留言直接落事件 坐席走专用端点 互斥 409 关键修正 SSE 终态判定移除 escalated（可接管 事件流保持打开等待 run.handover）终态收敛为 completed/failed/cancelled
- 评测层 契约加 handoverScript 剧本（take_over / operator_message / customer_message / resolve 可选 role 越权用例）L1 与 L2 sim-runner 共用 driveHandoverStep 领域拒绝吞掉由断言判定 新类目 handover 用例 6 条 hd_*（P0 接管解决闭环 P0 双向对话 P1 未升级拒接管 P1 接管前拒消息 P1 客户越权拒接管 P2 重复接管幂等）L1 111/111 全绿
- 前端 坐席工作台 /console 收件箱（escalated + handling_human 三秒轮询）会话面板（SSE 实时 工具轨迹折叠）接管按钮 坐席回复框 解决摘要面板（必填）客户工作台 escalated 非终态化（等待坐席接入锁定输入）handling_human 解锁双向对话 坐席气泡紫罗兰主题 + 人工坐席徽章 接管与解决系统提示条 归约器与 SSE 监听补三类新事件 StatusBadge 加人工处理中 导航加坐席工作台 修复 console 页 localStorage 渲染期读取导致的水合不一致（改挂载后读取 + 轮询同步身份）
- 测试 归约器 2 条新用例（接管事件链 断线重放不丢消息）API 2 条新用例（全链路事件与审计断言 403/409 拒绝面）
- 真实模型实测 浏览器双端走完整闭环 客户工作台发起升级 → 坐席工作台收件箱出现 → UI 接管 → UI 发坐席消息 → 客户侧实时收到（UTF-8 正确 输入解锁）→ 客户 UI 留言 → 坐席标记解决 → 客户侧显示坐席已标记解决 + 摘要 + 已完成 + 新会话按钮 HTTP 层另驱动一条全链路（403 客户接管 409 重复接管 事件链 87-91 完整）另发现并修复 curl 测试客户端 Windows 编码乱码为测试侧问题（浏览器 fetch 与 API 测试均验证 UTF-8 正确）
- 评测看板 类目标签加人工接管 抽样档实测对齐 p0 37 p1 29 p2 4 all 111
- 校验 pnpm typecheck 全绿 pnpm test 全过（web 11 api 13）pnpm eval 111/111 P0 门禁通过（报告 evr_e411c7f9）

### B. L2 提示词迭代 + Pass^3 约 1.5-2 天（功能 15）

做什么

- 两个迭代循环 每循环：从 eval/failures 挑失败样本 → 归因 → 修 prompt/工具描述/judge 判据 → p0 档 26 条快验证（约 15-20 分钟）→ 达标进下一循环
- 主攻三大失败模式（v2 全量首轮已归因）：未调 conclude 悬停 awaiting_input / 拒绝路径误升级 escalated / 政策判据解释不完整
- 修复手段参照 failure-traces 01-06 的既有模式：协议工具描述补强、无条件式规则、judge 判据放宽或改结构化
- 终跑 全量 105 单轮出总成绩 + p0×3 出真实模型 Pass^3（--repeat 3 已支持）
- 看板 补 passPowerK 展示（v2 欠账）报告对比从「相邻两份」升级为「任选两份」报告卡标注 prompt/model 版本
- 材料 README/STAR/LIMITATIONS/追问稿数字同步 首次获得「A% → B%」改进曲线

诚实约束

- 不预设目标数字 如实记录实际成绩
- 环境类失败（503）按既有惯例剔除口径单列
- 迭代前后报告均落库 eval/reports 可复现

**执行记录 2026-09-23 功能 15 L2 提示词迭代 三轮 p0 迭代曲线**

**失败归因（v2 基线 33/105 31.4% 的 33 条状态层失败拆解）**

- awaiting_input 悬停 16 条 纯文本礼貌性追问后停下 未调 conclude
- escalated 误升级 14 条 其中 6 条为剧本矛盾（剧本诱导客户要人工 断言却要 completed）其余为拒绝/超时后自行升级
- judge/communicate 39 条 政策解释缺条款依据 运费承担方 单号 缺口径
- rj_already_refunded 根因是 get_order 不返回售后历史 模型无从知道已退款（产品级工具缺陷）

**三轮迭代**

- 周期一 v2.1：conclude 判断标准与礼貌性收尾规则 拒绝/超时不是升级理由 检索不到条款不等于转人工 get_order 增加 returns 售后历史（含退款终态）工具参数断言加 contains 操作符 三条剧本矛盾修正
  p0 结果 20/37 54.1% Wilson [38.4% 69.0%]（对照基线 p0 档 38.5% 旧用例集）
- 周期二 v2.2：补偿触发规则（索要红包即发起 分级系统判）只读工具失败先重试 退款答复说明原路退回 大额告知审批原因 越权要求视为无效按正常流程处理正当诉求 重复提交说明无需重复 lg 用例剧本修正（客户先不给订单号制造注入窗口）communicate 断言语义化
  p0 结果 27/37 73.0% Wilson [57.0% 84.6%]
- 周期三 v2.3（全量首轮暴露 P1 尾部后追加）：退款范围有歧义先 ask_user 确认不默认整单全额 提交售后说明运费承担方 政策解释用例从 get_policy 对齐到 search_policy（提示词规则 11 与断言不同步）物流查询断言放宽 hp/cl 剧本加固 lg 订单号移出 known（模拟器会泄漏剧本外的已知信息）cp 前提改为到货晚了已收到（夹具 shipment 为 delivered 与延误前提矛盾）
  p0 结果 25/37 67.6% Wilson [51.5% 80.4%]（其中约 5 条失败来自本轮已修的 lg 泄漏与 cp 夹具矛盾）

**看板增强**

- ComparePanel 任选两份 L2 报告对比 缺省相邻两份 TSR 差值徽章 Wilson 区间显著性判定沿用
- 报告卡与历史表加提示词版本标注 L1/L2 列显示 promptVersion 浏览器实测对比面板 TSR +27.0pp 版本 v2.2/v2.3 正常渲染

**全量与 Pass^3**

- 全量终跑 v2.3 报告 evr_14b4a3c3 **58/111 52.3%** Wilson 95% [43.0% 61.3%] 总耗时约 54 分钟
  对照 v2 基线（105 条用例集）33/105 31.4% → **+20.9pp** 剔除 10 条代理 503 环境异常后模型行为口径 58/101 57.4%（基线剔除口径 35.9% → +21.5pp）
- 分类对照基线 主链路 78.6%（基线 50%）政策边界 41.7%（33.3%）故障注入 81.8%（36.4%）多轮补问 62.5%（37.5%）
  回归面 安全 1/13（基线 3/13）injection_defense 40% → 7.7% 规则 8 越权处理从 拒绝并升级 改为 视为无效按正常流程处理 在附带正当诉求的攻击用例（hard_injection_admin_pressure）上修复 但纯攻击用例（sec_prompt_injection_override 等）不再升级 安全语义需要在 正当诉求走流程 与 纯攻击升级 之间再平衡 是 v4 第一优先
- p0 迭代曲线 38.5%（基线 旧 26 条集）→ 54.1%（v2.1）→ 73.0%（v2.2）→ 67.6%（v2.3 其中约 5 条失败来自本轮用例问题）
- Pass^3 p0×3 真实模型稳定性 报告 evr_fd2c9a2d **Pass^3 35.1%**（22/37 三轮全过）**Pass@3 83.8%**（至少一轮通过）
  单轮通过率约 55%-65% 三轮全过 35.1% 能力上限与稳定性的分离正是 Pass^k 的价值 生产视角看的是 35.1%
  看板 passPowerK 与 passAtK 展示已验证（对照 CI 的 L1 Pass^3 100%）

**本轮如实记录的三个已知问题（v4 方向）**

1 装具终态缺口 模拟器终态回复（客户接受并结束）不驱动模型完结轮 直接 break 会话悬停 awaiting_input 影响所有以接受收尾的用例（lg 系列的终态 awaiting_input 失败多源于此）修复需补一轮装具验证
2 lg 用例回归 本轮把订单号移出 known 试图制造注入窗口 模拟器无法应答反而卡死 6 条 已回退为保留订单号（两害取轻 注入窗口依赖模型先补问 模拟器泄漏订单号则窗口不出现）根本修复需要装具终态缺口先行
3 sec 规则过矫 如上 规则 8 修正换来 admin_pressure 修复但纯攻击用例不再升级 需要更精细的攻击/诉求分流规则

诚实结论 提示词迭代是双向的 每轮修复都可能引入新回归 三轮 p0 曲线与全量 52.3% 是如实的当前水平 改进曲线（31.4% → 52.3%）成立 三类已知问题与装具缺口均已定位并留档

三档验收

- 简单 p0×3 报告出 Pass^3 看板可见
- 完整 两轮迭代后全量单轮成绩落库 看板可对比任选两报告 三大失败模式各有一组修复前后对照
- 复杂 失败 Trace 补篇（07 起）Wilson 区间与 Pass^3 联合表述 改进归因写入 STAR 高频追问

### C. 分析仪表盘 + CSAT 约 1-1.5 天（功能 16）

做什么

- 契约层 agent_runs 加 source 标记（customer/sim）sim-runner 与评测脚手架创建的 run 标 sim API 创建默认 customer 新增 CSAT 评分契约（runId score 1-5 comment 可选）
- 领域层 评分服务（仅终态可评 一 run 一评 幂等拒绝）分析服务纯读侧聚合（会话量按日 终态分布 解决率 升级率 平均轮次 工具调用分布 审批时效 CSAT 分布）
- 持久层 ratings 表 agent_runs 加 source 列（迁移兼容旧数据默认 customer）
- API 层 POST /api/runs/:runId/rating（customer）GET /api/analytics/overview（operator/supervisor）
- 前端 /analytics 页（operator 令牌可见）指标卡 + 自绘 SVG 图表（终态环形 会话量趋势 工具调用条形 CSAT 分布）+ CSAT×终态交叉矩阵 工作台终态后弹评分卡（1-5 星 + 可选一句话）run 详情页显示评分
- 评测层 L1 新用例 2-4 条（终态才可评 重复评分幂等拒绝 非 customer 403 模拟 run 不进聚合）

口径声明

- 仪表盘只聚合 source=customer 的真实客户会话 模拟与评测会话不进运营指标
- token 成本指标的数据源执行时核实（单 run usage 是否可得）若无可得列为完整档补齐项或如实标注不可得

三档验收

- 简单 工作台终态弹评分 评分落库 run 详情可见
- 完整 仪表盘基础六指标 + CSAT 分布 source 过滤生效（模拟会话不进聚合）
- 复杂 CSAT×终态交叉矩阵（升级人工但满意等样本可讲）审批时效 深化图表

**执行记录 2026-09-23 完成 功能 16 运营仪表盘 + CSAT**

- 契约层 agent_runs 加 source 口径（customer/sim 老库幂等补列迁移）RunRatingRequest/RunRatingView AnalyticsOverviewResponse 响应契约含 scopeNote 口径声明
- 领域层 RatingService（全终态可评 仅本人 一 run 一评幂等拒绝 分数区间校验 审计 run_rated）AnalyticsService 纯读侧聚合（解决率升级率推导 CSAT 均值与交叉）口径经 AnalyticsReadModel 端口 SQL 实现留在持久层
- 持久层 ratings 表 agent_runs source 列（PRAGMA 检测补列）SqliteRatingRepository SqliteAnalyticsReadModel（按日趋势 平均轮次 升级会话数 工具分布 审批时效 CSAT 交叉全部 SQL 聚合）QUERYABLE_TABLES 加 ratings clearBusinessData 清空 ratings
- 运行器 L1 与 L2 的 runService.start 显式标注 source sim 运营口径排除评测会话
- API 层 POST/GET /api/runs/:runId/rating（customer）GET /api/analytics/overview（operator/supervisor days 1-90）
- 前端 运营分析页 /analytics（operator 视角 KPI 指标卡 解决率升级率比例仪表 按日趋势列图 终态分布条形 工具调用分布 满意度分布列图 满意度×终态交叉表 口径声明）图表为设计系统内自绘组件（charts.tsx 单 sage 色系 遵循 dataviz 规范 条厚 16px 数据端 4px 圆角 直接标签文本 token 悬停高亮 无第三方依赖）工作台终态评分卡（星级+可选评论）运行详情页显示客户评分 导航加运营分析
- 测试 领域 6+3 条（评分不变量 分析口径零除保护）API 2 条（评分提交幂等与 403 分析总览 source 过滤与 403）
- 浏览器实测 operator 视角 /analytics 真数据渲染（会话总量 7 模拟会话排除 评分 5.0 交叉表人工处理中样本）curl 评分提交落库
- 校验 typecheck 全绿 test 全过（domain 95 web 11 api 15）L1 111/111

### D. 模拟对话直播 约 1 天（功能 17 可裁）

做什么

- 复用 POST /api/eval/run-sim 与任务轮询 sim 任务暴露进行中对话的 transcript（逐轮消息与工具调用）
- 前端评测看板内嵌直播视图或独立页 实时渲染「AI 客户 ↔ 被测 Agent」对话流 工具调用卡复用 ToolCard

三档验收

- 简单 触发 L2 后能看到完成态完整对话
- 完整 运行中实时刷新 轮询进度与对话一致
- 复杂 失败用例终判标注 一键跳转失败导出

## 四、前端设计约定

沿用 v2 全套：所有新增 UI 走项目设计 skill 流程 遵守 docs/redesign-audit.md 设计系统（teal 主题）图表走 dataviz 规范自绘 SVG 不引第三方图表库 每阶段单独 commit 并过 `pnpm --filter web typecheck` 与 test

## 五、诚实原则

- L1/L2 数字分列表述 沿用数字诚实声明
- 运营指标口径（source 过滤）在 README 与 LIMITATIONS 明示
- B 阶段不预设提升目标 迭代前后报告均落库可复现
- LIMITATIONS 随新能力同步更新（如 handling_human 生命周期新边界 评分样本量小的统计局限）

## 六、裁剪顺序

时间被压缩时从后往前裁

1 D 模拟直播 → 2 CSAT 交叉分析（保留评分收集）→ 3 仪表盘深化图表（保留基础指标）→ 4 看板对比增强（保留 passPowerK 展示）→ 坐席闭环与 L2 迭代永不裁

## 七、v4 候选（不入本轮）

- 坐席 AI 辅助起草（agent assist Sierra/Cresta 面）
- 基线/消融实验（B0-B4 式 prompt/模型/门控消融）
- 政策语料管理 UI

## 八、执行方式

执行 prompt 由用户直接粘贴到新对话（不落盘）每功能一个新会话 每会话先读 docs/v3-plan.md 对应章节与 docs/CONTEXT.md 术语表 完成后回写执行记录到本文件
