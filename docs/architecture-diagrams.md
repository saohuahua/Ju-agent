# 架构图与状态机图

mermaid 版本 与 [architecture.md](architecture.md) 的 text-art 图互补 本文渲染为图形 状态枚举与迁移以 contracts/enums.ts 为权威源

## 系统架构图

```mermaid
flowchart TB
  subgraph WEB["apps/web Next.js 工作台"]
    WS["会话工作台 流式对话"]
    AP["审批中心"]
    RD["运行详情 事件时间线"]
    EV["评测看板"]
  end

  subgraph API["apps/api Hono"]
    REST["REST 端点"]
    SSE["SSE 事件流 断线续传"]
    AUTH["认证 错误契约"]
  end

  subgraph RT["packages/runtime 组合根"]
    C["composeSystem 装配"]
    C -. "评测与 API 共用同一装配" .-> C
  end

  subgraph AG["packages/agent"]
    CM["ChatModel 接口<br/>ScriptedModel / AnthropicModel"]
    AR["AgentRunner 循环<br/>能力门控 上下文归约"]
  end

  subgraph WF["packages/workflow"]
    WE["WorkflowEngine 确定性<br/>步骤 事件 断点 租约"]
  end

  subgraph TL["packages/tools"]
    TR["工具注册表<br/>故障注入 支付网关"]
  end

  subgraph DM["packages/domain"]
    EN["实体与状态机"]
    PE["政策引擎 版本化规则"]
    SV["领域服务 仓储接口"]
  end

  subgraph PS["packages/persistence"]
    RE["SQLite 仓储 事件存储 夹具"]
  end

  subgraph CT["packages/contracts"]
    SC["枚举 迁移 事件协议 工具契约 用例 Schema"]
  end

  subgraph EVS["packages/eval"]
    SU["模拟套件 L1 脚本 / L2 真实模型"]
    VD["确定性验证器"]
    JG["LLM Judge 与模型分离"]
  end

  WEB -->|HTTP + SSE| API
  API --> RT
  RT --> AG
  RT --> WF
  RT --> TL
  AG --> WF
  AG --> TL
  WF --> DM
  TL --> DM
  DM -->|仓储接口 依赖倒置| PS
  DM --> CT
  PS --> CT
  EVS --> RT
  EVS --> CT

  classDef layer fill:#f0f4f1,stroke:#5c7c6e,stroke-width:2px
  class WEB,API,RT,AG,WF,TL,DM,PS,CT,EVS layer
```

依赖规则 单向向下 domain 不依赖 persistence 由仓储接口倒置 评测与运行时共用同一组合根 评测环境即运行环境

## Agent 运行状态机图

```mermaid
stateDiagram-v2
  [*] --> created : 会话创建
  created --> running : 用户消息
  running --> awaiting_input : ask_user 补问
  awaiting_input --> running : 用户答复 恢复
  running --> awaiting_approval : 高风险动作 审批创建
  awaiting_approval --> running : 审批通过 令牌验证续跑
  awaiting_approval --> completed : 审批拒绝 告知客户
  awaiting_approval --> awaiting_approval : 审批过期 重新申请
  running --> escalated : escalate 升级人工
  running --> completed : conclude 任务完成
  running --> failed : 校验失败 / 模型错误
  escalated --> handling_human : 坐席接管 功能14
  handling_human --> completed : 坐席标记解决 附摘要
  completed --> [*]
  failed --> [*]
```

任何状态随时可从事件表重建上下文 断点续跑跳过已完成步骤 审批通过后模型可见摘要必须显式置为 approved

## 售后单状态机图

```mermaid
stateDiagram-v2
  [*] --> submitted : 业务动作提交
  submitted --> auto_approved : 政策 allow 小额直通
  submitted --> awaiting_approval : 大额 / 高风险 需审批
  submitted --> rejected : 政策 deny
  awaiting_approval --> approved : 主管通过
  awaiting_approval --> rejected : 主管拒绝
  awaiting_approval --> expired : 超时未决
  approved --> awaiting_buyer_shipment : 退货类 待买家寄回
  auto_approved --> awaiting_buyer_shipment : 退货类 待买家寄回
  auto_approved --> completed : 仅退款 退款成功
  approved --> completed : 仅退款 退款成功
  awaiting_buyer_shipment --> buyer_shipped : 买家寄回
  buyer_shipped --> goods_received : 仓库收货
  goods_received --> completed : 退款执行
  rejected --> [*]
  expired --> [*]
  completed --> [*]
```

退款单状态 created → executing → succeeded / failed 由审批环节把关 created 到 executing 之间必须持有效审批令牌 执行前幂等记录与令牌双重校验
