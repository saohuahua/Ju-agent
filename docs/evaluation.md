# 评测方法论

## 评测哲学

回复看起来正确和业务做对是两件事 本项目的评测只认确定性证据
数据库里的退款金额 状态 审计 记录 网关的扣款次数 才是成败依据
LLM Judge 只用于回复质量解释 且永远不参与任务成败

## 用例契约

每条用例是一个完整任务定义 位于 packages/eval/src/cases

```text
id category priority
fixture 基线夹具名
fixturePatch 定向补丁 修改订单时间 状态 类目
actor 发起身份 决定归属校验走向
turns 用户回合序列
modelScript 脚本化模型输出 按调用顺序消耗 与轨迹一一对应
faultPlan 故障注入 timeout rate_limited server_error crash
approvalAction 审批处理 approve reject expire
operatorActions 运行后的运营动作 寄回 收货
frozenTime 冻结时钟
assertions
  expectedState 数据库断言 列名使用数据库蛇形命名
  trajectory 必选工具 禁止工具 有序子序列 参数匹配 步数上限
  expectEscalation expectClarify 升级与补问预期
  expectGatewayCharges 网关成功扣款次数
```

## 当前数据集 32 条

| 分类            | 数量 | 覆盖                                       |
| --------------- | ---- | ------------------------------------------ |
| happy_path      | 7    | 查单 查物流 政策解释 仅退款 退货 换货 丢件 |
| clarification   | 3    | 缺订单号 缺原因 换退选择                   |
| policy_boundary | 5    | 超时 生鲜 定制 15 天边界 部分退款金额      |
| approval        | 3    | 批准 拒绝 过期                             |
| rejection       | 2    | 重复申请 不退货仅退款                      |
| fault_injection | 4    | 超时重试 限流重试 持续故障升级 无物流记录  |
| security        | 4    | 越权 提示词注入 虚构承诺 PII 脱敏          |
| recovery        | 4    | 中断恢复 重复提交 退货全闭环 换货全闭环    |

优先级 P0 14 条 P1 13 条 P2 5 条 P0 全过才过门禁

安全类用例刻意让脚本化模型扮演被误导的弱模型 验证系统层纵深防御
这个设计的含义是 即使换一个更差的模型 系统依然不出资金事故

## 运行方式

```bash
pnpm eval                      # 单轮 全量
pnpm eval -- --repeat 3        # 三轮 输出 Pass^3
pnpm eval -- --model anthropic # 真实模型模式 需要 ANTHROPIC_API_KEY
pnpm eval:dataset              # 导出公开数据集 JSON
```

脚本套件全量一轮约 1 秒 三轮约 3 秒 具备每次提交都跑的条件

## 指标定义

| 指标                       | 定义                     | 数据来源 |
| -------------------------- | ------------------------ | -------- |
| task_success_rate          | 全部断言通过的用例比例   | 验证器   |
| side_effect_correctness    | 副作用类目通过比例       | 分类     |
| tool_selection_accuracy    | 轨迹断言通过比例         | 轨迹验证 |
| tool_argument_accuracy     | 参数断言通过比例         | 轨迹验证 |
| policy_violation_rate      | 政策与安全类目未通过比例 | 分类     |
| duplicate_side_effect_rate | 网关扣款断言未通过比例   | 网关     |
| checkpoint_recovery_rate   | 恢复类目通过比例         | 分类     |
| injection_defense_rate     | 安全类目通过比例         | 分类     |
| clarification_quality      | 补问类目通过比例         | 分类     |
| escalation_correctness     | 升级断言通过比例         | 验证器   |

## Pass^k 与 Pass@k

Pass@k k 次至少成功一次 衡量能力上限 适合研究
Pass^k k 次全部成功 衡量稳定性 生产 Agent 的正确指标

脚本模型确定性输出 两值恒等 真实模型模式下两值分离 才是模型稳定性的真实度量

## 中断恢复语义

crash 故障在工具执行前抛出 不写任何失败状态 模拟进程死亡
恢复时已完成步骤按断点跳过 副作用工具靠幂等双保险
rec_crash_resume_no_double_refund 断言三件事 退款成功 步骤未重复执行 网关只扣款一次

## Badcase 回流流程

1. 评测失败的用例输出失败断言明细与报告路径
2. 人工确认是系统缺陷还是预期变化
3. 系统缺陷 修复后重跑 回归确认
4. 预期变化 更新用例与断言 并在用例 description 记录原因
5. P0 用例变更需要在评审中说明 不允许悄悄放宽断言

## 版本对比实验

报告携带模型 提示词 代码三元组 支持以下对比

- B0 基线 ScriptedModel 确定性满分 证明系统正确性
- B1 真实模型 anthropic 模式 衡量模型加提示词的真实能力
- B2 换模型 调 ANTHROPIC_MODEL 环境变量
- B3 改提示词 PROMPT_VERSION 递增 对比两版本报告
- B4 改工具描述 对比轨迹断言失败分布 定位受影响用例
