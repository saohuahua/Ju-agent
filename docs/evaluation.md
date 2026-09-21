# 评测方法论

## 评测哲学

回复看起来正确和业务做对是两件事 本项目的评测只认确定性证据
数据库里的退款金额 状态 审计 记录 网关的扣款次数 才是成败依据
LLM Judge 只用于回复质量解释 且永远不参与任务成败

## 两级评测体系

| 层级 | 命令 | 被测对象 | 成本 | 运行时机 |
| --- | --- | --- | --- | --- |
| L1 脚本化回归 | `pnpm eval` | 运行时与治理层（模型为脚本） | 零成本 约 1 秒 | 每次提交 CI 门禁 |
| L2 用户模拟 | `pnpm eval:sim` | 真实模型的完整智能链路 | 每用例数秒与数千 token | 发版前 |

L1 用 ScriptedModel 回放理想轨迹 证明管道与治理正确性
L2 用 tau2-bench 范式的用户模拟器与真实模型多轮对话 证明 Agent 智能层表现
两层成绩分开表述 L2 无密钥时诚实跳过 不输出模拟成绩

## 用例契约

每条用例是一个完整任务定义 位于 packages/eval/src/cases

```text
id category priority
fixture 基线夹具名
fixturePatch 定向补丁 修改订单时间 状态 类目
actor 发起身份 决定归属校验走向
turns 用户回合序列 L1 使用
modelScript 脚本化模型输出 按调用顺序消耗 与轨迹一一对应 L1 使用
scenario 模拟客户场景 L2 使用
  persona 人设 normal 平缓 impatient 急躁 confused 迷糊
  reasonForContact 来电原因
  known 已知信息 未列出的客户不可知 实现选择性信息隐藏
  instructions 行为剧本 接受什么 拒绝什么 何时终止
faultPlan 故障注入 timeout rate_limited server_error crash
approvalAction 审批处理 approve reject expire
operatorActions 运行后的运营动作 寄回 收货
logisticsEvents 物流事件注入 at 取 before_first_turn after_turn after_all_turns
frozenTime 冻结时钟
assertions
  expectedState 数据库断言 列名使用数据库蛇形命名
  trajectory 必选工具 禁止工具 有序子序列 参数匹配 步数上限
  expectEscalation expectClarify 升级与补问预期
  expectGatewayCharges 网关成功扣款次数
  communicateInfo 回复必须说到的关键信息 子串匹配 代码判定
  judgeRubric 主观判据 二元可从 transcript 验证 仅走 LLM judge
```

## 用户模拟器设计 tau2-bench 范式

- 模拟器与被测模型强制分离 模拟器默认 Haiku 被测为任意真实模型
- 角色翻转 Agent 发言以 user 角色注入 模拟器以 assistant 角色生成客户发言
- 一回合一条消息 改述不背诵 信息渐进披露
- 终止哨兵 客户目标达成输出 ###STOP### 要求人工输出 ###TRANSFER###
- 三档人设 急躁客户会施压 迷糊客户会答非所问 压力测试 Agent 的收敛能力

## 判定三层

1. 终态断言 代码判定 数据库状态 网关扣款 零偏差
2. 轨迹与沟通断言 代码判定 工具轨迹 communicateInfo 子串匹配
3. LLM judge 仅 judgeRubric 主观项 judge 模型与被测模型分离 判据二元化
   判定失败或输出无法解析时保守计入失败

## 当前数据集 96 条

| 分类            | 数量 | 覆盖                                       |
| --------------- | ---- | ------------------------------------------ |
| happy_path      | 14   | 查单 查物流 政策解释 仅退款 退货 换货 丢件 物流推送触达 |
| clarification   | 8    | 缺订单号 缺原因 换退选择                   |
| policy_boundary | 12   | 超时 生鲜 定制 15 天边界 部分退款金额      |
| approval        | 8    | 批准 拒绝 过期 大额催压 审批期间事件挂起   |
| rejection       | 12   | 重复申请 不退货仅退款 超时发火 怒要人工 物流注入拒绝 |
| fault_injection | 11   | 超时重试 限流重试 持续故障升级 无物流记录 急躁遇超时 |
| security        | 13   | 越权 提示词注入 虚构承诺 PII 脱敏          |
| recovery        | 10   | 中断恢复 重复提交 退货全闭环 换货全闭环 迷糊重复提交 |
| compensation    | 8    | 小额自动发放 阈值边界 重复拦截 大额审批三态 金额确认 愤怒安抚 |

物流推送 8 条按主题归入 happy_path approval rejection 三类 覆盖空闲即达触达 丢件退款闭环 忙时挂起 注入拒绝与幂等

sim-hard 变体 17 条按主题归入上述九类 是 L2 的核心场景 人设压力与行为曲折 模型脚本只作 L1 理想轨迹

优先级 P0 29 条 P1 51 条 P2 16 条 P0 全过才过门禁

安全类用例刻意让脚本化模型扮演被误导的弱模型 验证系统层纵深防御
这个设计的含义是 即使换一个更差的模型 系统依然不出资金事故

## 运行方式

```bash
pnpm eval                                # L1 单轮 全量 零成本
pnpm eval -- --repeat 3                  # L1 三轮 输出 Pass^3
pnpm eval:dataset                        # 导出公开数据集 JSON
pnpm eval:sim                            # L2 P0 全量 用户模拟 需要密钥
pnpm eval:sim -- --repeat 3              # L2 三轮 输出 Pass^3
pnpm eval:sim -- --sample all            # L2 全部带场景用例
pnpm eval:sim -- --sample p1             # L2 分层抽样 P1 抽一半 P2 抽五分之一
pnpm eval:sim -- --case hp_refund_only_small    # 单用例调试
pnpm eval:sim -- --agent-model claude-sonnet-5  # 指定被测模型
```

L2 成本控制 分层抽样 P0 全量 P1 P2 按比例抽 失败用例自动导出
eval/failures/ 含场景与完整 transcript 人工归因后可提升为正式回归用例

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
