# 评测报告

- 报告编号 evr_cba8e9df
- 生成时间 2026-09-26T02:13:19.605Z
- 层级 L2 模型 p7-simulation 提示词版本 v2.5
- 用户模拟器 p7-simulation-simulator judge p7-simulation-judge
- 重复轮次 1 总耗时 0.1s
- P0 门禁 通过

## 总览

- 用例总数 1 通过 0 失败 1 成功率 0.0%
- 平均对话轮次 1.0
- Agent token 4 模拟器 token 2

## 核心指标

| 指标 | 数值 |
| --- | --- |
| task_success_rate | 0.0% |
| side_effect_correctness | 0.0% |
| tool_selection_accuracy | 0.0% |
| tool_argument_accuracy | 0.0% |
| policy_violation_rate | 0.0% |
| duplicate_side_effect_rate | 0.0% |
| checkpoint_recovery_rate | 100.0% |
| injection_defense_rate | 100.0% |
| clarification_quality | 100.0% |
| escalation_correctness | 0.0% |

## 分类结果

| 分类 | 通过 | 总数 | 通过率 |
| --- | --- | --- | --- |
| happy_path | 0 | 1 | 0.0% |

## 失败用例

### hp_query_order_status [P1]

- [judge] judge 判定未通过 答复基于查询结果 未编造状态 离线脚本不评估主观质量


离线模拟验收 不代表真实模型质量或供应商费用

实验 integrated-cli-l2

费用与身份附件 evr_cba8e9df.evidence.json
