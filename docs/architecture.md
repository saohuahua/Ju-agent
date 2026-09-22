# 系统架构

## 分层总览

```text
apps/web  Next.js 工作台
  会话工作台 审批中心 运行详情 评测看板
        │  HTTP + SSE  只消费契约 不导入后端包
        ▼
apps/api  Hono HTTP 服务
  REST 端点 SSE 事件流 认证 错误契约
        │
        ▼
packages/runtime  组合根
  装配仓储 服务 工具 工作流 Agent
  评测与 API 共用同一份装配 评测环境即运行环境
        │
   ┌────┴─────────────────┬──────────────────┐
   ▼                      ▼                  ▼
packages/agent      packages/workflow   packages/tools
  ChatModel 接口      确定性工作流引擎      工具注册表
  ScriptedModel       审批暂停恢复         故障注入执行器
  AnthropicModel      断点与租约           Mock 支付网关
  AgentRunner 循环    意图到步骤映射          │
   │                      │                  │
   └──────────┬───────────┴──────────────────┘
              ▼
        packages/domain  纯领域层
          实体 状态机 政策引擎 领域服务 仓储接口
              │
              ▼
        packages/persistence  SQLite 实现
          仓储实现 事件存储 夹具 单号计数器
              │
              ▼
        packages/contracts  共享契约
          枚举 迁移表 事件协议 工具契约 评测用例 Schema
```

依赖规则 单向向下 domain 不依赖 persistence 依赖倒置由接口保证
两层仓储实现 内存版用于领域单测 SQLite 版用于运行 互证接口不泄漏实现

## Agent 运行生命周期

```text
用户消息
   ▼
AgentRunner 重建上下文 从事件表归约 加 working memory 便签与超限压缩
   ▼
模型原生 tool calling tool_use 块与参数增量流式先落事件再执行
   ├── 只读工具     get_order 等 白名单四项 执行后 tool_result 回灌
   ├── ask_user     协议工具 补问 运行暂停 awaiting_input 用户回复构成 tool_result
   ├── 业务动作工具 submit_* 槽位校验后路由工作流 能力门控 未查单不可见
   ├── escalate     升级人工 运行终态
   └── 纯文本轮     end_turn 即最终答复 脱敏落事件 运行完成
   ▼
WorkflowEngine 确定性执行
   每步 先发事件 再执行 后存断点
   高风险 审批创建 暂停 awaiting_approval
   审批通过 令牌验证 续跑
   中断 任何时刻可从断点恢复 已完成步骤跳过
```

## 退款安全链

```text
action submit_refund_only
   ▼
工作流 verify_order 自行重查归属 不信任模型
   ▼
政策引擎 decidePolicy 确定性规则 版本化
   ├── deny      售后单 rejected 终态
   ├── allow     小额直接进入执行
   └── needs_approval  审批创建 一次性令牌 主管决定
   ▼
execute_refund 三道防线
   1 幂等记录命中 直接返回既有结果 不触碰网关
   2 审批令牌校验 大额路径必验 消费后失效
   3 网关按幂等键去重 极端情况也不会二次扣款
   ▼
退款单状态机 created → executing → succeeded/failed
售后单状态机 submitted → auto_approved/awaiting_approval → ...
```

## 事件协议

事件先落库再产生副作用 每事件携带 run 内单调 sequence

```text
run.started        运行启动 含提示词与模型版本
message.user       用户消息
message.delta      回复流式片段
message.completed  回复权威全文 重放以此为准
agent.output       模型结构化输出 供上下文重建与审计
step.started       工作流步骤开始
step.completed     步骤完成 ok skipped failed
tool.requested     工具调用 已脱敏参数
tool.completed     工具结果 含错误码与耗时
approval.required  需要审批 含金额与截止时间
approval.decided   审批决定
run.paused         暂停 awaiting_input 或 awaiting_approval
run.resumed        恢复 来源 user_message approval checkpoint
run.failed         失败 含错误码
run.completed      完成
run.escalated      升级人工
run.handover       坐席接管 会话转人工处理
operator.message   坐席消息 人工处理中直落事件流
run.resolved       坐席标记解决 附摘要
```

断线补发 客户端携带 Last-Event-ID 服务端从持久化事件表续传
刷新重建 客户端从 sequence 1 全量归约 纯函数 reducer 保证幂等

## 评测闭环

```text
用例契约
  夹具基线 + 定向补档 + 冻结时钟 + 脚本化模型 + 故障计划 + 断言集
       ▼
运行器 每用例独立内存库
  重置 → 驱动回合与审批 → 断点恢复 → 收集终态与轨迹
       ▼
确定性验证器
  数据库断言 eq ne exists count contains
  轨迹断言 必选 禁止 有序子序列 参数 步数上限
  网关扣款次数断言 重复副作用最终证据
       ▼
指标与门禁
  分层指标 按类目汇总 Pass^k 稳定性
  P0 全过才放行 CI 非零退出
       ▼
报告
  JSON + Markdown 落盘 写入业务库供看板查询
```
