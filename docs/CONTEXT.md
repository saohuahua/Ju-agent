# 术语表 业务概念词汇一致

新业务概念进场时在此沉淀 保证代码 用例 文档用词一致

## 补偿（功能 6）

- **补偿单（compensation）** 现金红包安抚 单号 CP-* 与售后单（RT-*）退款单（RF-*）并列
- **补偿原因** 仅两种 物流延误 服务道歉 契约留有扩展位
- **分级阈值** 50 元分界 ≤5000 分自动发放（C1_auto_small）>5000 分人工审批（C2_large_approval）
  与退款大额审批阈值（5000 元）相互独立 各自政策规则
- **不可叠加** 同一订单同一原因仅一次 occupied 状态幂等拒绝
  rejected/expired/cancelled 不占位 可换原因重试
- **执行中态（executing）** 网关调用中间态 失败回 failed 可重试 与退款状态机平行
- **补偿幂等键** compensation:CP-* 与退款 refundIdempotencyKey 同构 双防线（幂等记录 + 网关键）

## 物流推送（功能 7）

- **物流事件（logistics event）** 运行中途注入的运单状态变化 落 agent_events 的 logistics.event 事件
  区别于 Agent 主动查询（get_shipment 工具）
- **混合到达语义** 会话 awaiting_input 时即达即触达 其余状态事件挂起 下一轮纳入上下文
- **触达（proactive reach-out）** Agent 因物流事件主动发消息告知客户 不等客户开口
- **运单状态（shipment status）** in_transit 运输中 delayed 延误 lost 丢件 delivered 已签收 exception 异常
- **注入方** 运营端点（operator 手动 demo）与 L2 模拟器剧本 共用同一注入服务与 API

## 人工接管（功能 14）

- **人工处理中（handling_human）** 坐席接管后的运行状态 escalated → handling_human → completed
  escalated 不再是死终态 接管是唯一出口
- **接管（handover / take over）** operator 或 supervisor 把升级会话收归人工
  仅 escalated 可接管 重复接管与越权（客户）均被领域拒绝 事件 run.handover
- **坐席消息（operator message）** 人工处理中坐席直接落事件流的消息 不经模型
  客户工作台经 SSE 实时可见 事件 operator.message
- **标记解决（resolve）** 坐席附解决摘要把会话迁回 completed 终态
  摘要落审计与 run.resolved 事件 客户侧可见
- **人工会话客户留言** handling_human 中客户走消息端点直接落 message.user 事件 不驱动模型
- **权限分离** AI 不碰终审（升级即交出） 坐席不碰业务执行（退款补偿仍走审批中心）

## 运营分析与满意度（功能 16）

- **会话来源（source）** agent_runs 的口径字段 customer 真实客户会话 sim 评测与模拟会话
  运营指标只聚合 source=customer 评测与运营共用同一数据库时靠此过滤
- **满意度（CSAT）** 会话终态后客户评分 1 到 5 星加可选一句话评论
  一 run 一评 幂等拒绝 全终态可评（含升级与人工处理中）
- **满意度与任务成功解耦** CSAT 只做运营观测 不参与评测任务成败判定
  评测看板（任务成功率）与运营分析（满意度）分开表述
- **满意度×终态交叉** 按会话终态分组的平均分 升级人工但满意 是人工接管价值的直接证据
- **解决率** completed 占比 **升级率** 发生过 run.escalated 事件的会话占比（含已被人工解决的）
- **审批时效** 已决审批从创建到决定的平均耗时
- **token 成本** 单 run usage 当前无落库来源 如实未纳入运营指标

## 双轨主题与深度可视化（功能 18 阶段 0）

- **前台轨（light track）** 客户侧界面 `/workbench` `/my` 暖白 stone + sage 浅色
  目的是安抚情绪 沿用 v1-v3 既有 token 不变
- **控制台轨（console track）** 运营侧与工程侧界面 近黑带绿调深色
  目的是暴露系统真相 根节点标注 `data-theme="console"` 切轨
- **区域语义而非用户偏好** 主题由路由决定 不用 Tailwind `dark:`（那表达 prefers-color-scheme）
  也不提供用户切换开关 深浅交界本身即前台后台的视觉证据
- **切轨机制** 重定义既有 token 取值 而非给元素换类名
  Tailwind v4 调色板本身是 CSS 变量 改变量即整轨生效 既有页面 JSX 未动
- **待建占位（planned）** 导航登记但尚未落地的页面 渲染为不可点的「待建」标记
  分组结构从第一天完整可见 又不给出会 404 的链接

- **工具目录变更（tools.catalog_changed）** 能力门控的可观测化事件
  agent 每轮构建工具目录时发出 `visible` 本轮喂给模型的工具 `gated` 被门控挡住的
  把「未查订单前动作工具不进目录」从代码行为变成可回放事实
- **防线拦截（guard.blocked）** 三道闸任一挡下重复副作用时落的事件
  `layer` 取 idempotency 业务幂等键 approval_token 一次性审批令牌 gateway 网关级去重
  拦截即代表未产生资金动作 是幂等三道防线的直接证据
- **上下文分段（context segments）** `context.compacted` 的可选 payload 字段
  分 workingMemory 状态便签 recent 最近消息 compacted 已清理历史三段
  由 agent 实测而非前端估算 让「上下文工程可量化」有后端数据撑腰

- **token 计量口径（TokenSource）** measured 真实模型 API usage 实测值
  estimated 脚本化模型按字符数估算 仅证明系统层正确性
  两者永不混算 口径写进数据本身 而不靠调用方记得区分

## 安全分流（功能 19 阶段 S）

- **越权三分法** 提示词 v2.5 把越权诉求拆成三类 处置各异
  A 类 out_of_scope 正当但本渠道办不了 → 拒绝并收尾 不升级
  B 类 injection_attempt 纯攻击 剥掉话术后无正当诉求 → 拒绝且升级且记审计
  C 类 正当诉求外包攻击话术（最常见）→ 否掉话术 照办正当诉求 不升级
- **剥话术判据** C 类的操作性判定 「剥掉话术之后 还剩一个本系统能办的正当诉求吗」
  有则 C 无则 B 这一句是三分法的核心 判错方向的代价两边都不对称
- **升级原因分类（EscalationKind）** escalate 工具的 kind 槽位
  customer_request emotional service_failure injection_attempt 四值
  分类只影响审计口径 不影响是否升级 误分类的失败方向是保守的（安全统计偏低）
- **注入拦截审计（injection_attempt_blocked）** 独立于 escalated_to_human 的审计动作
  kind=injection_attempt 的升级落此行 让「被攻击且拦住了」可单独计数
  供对抗沙箱（功能 30）与安全复盘直接按 action 查询
- **路径证据分层（StateAssertion.level）** 评测断言的 L1/L2 分层
  审计行 鉴权拒绝执行行 脱敏串这类证据只在「模型犯错被系统拦住」时产生
  L1 断言它们验证系统层拦得住 L2 只断言结果正确（无副作用 无扣款 无明文 PII）
  否则等于要求真实模型先犯错才算通过 把「结果正确」写成了「路径正确」

## 既有概念（沿用 不另起名）

- **审批令牌（approval token）** 一次性 只存断点不经过模型
- **幂等键（idempotency key）** 领域记录 + 网关键 两道防线
- **能力门控** 未查订单前动作工具不出现在工具目录
- **断点恢复（checkpoint resume）** 工作流逐步存档 从事件重建续跑
