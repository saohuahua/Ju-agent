# 评测报告

- 报告编号 evr_4beb5275
- 生成时间 2026-09-28T13:53:05.804Z
- 层级 L2 模型 p7-simulation 提示词版本 v2.5
- 用户模拟器 p7-simulation-simulator judge p7-simulation-judge
- 重复轮次 3 总耗时 0.8s
- P0 门禁 未通过

## 总览

- 用例总数 3 通过 0 失败 3 成功率 0.0%
- Pass^3 0.0% 全部轮次均通过
- pass@3 0.0%
- 平均对话轮次 1.0
- Agent token 18 模拟器 token 6

## 核心指标

| 指标                    | 数值   | 分母 |
| ----------------------- | ------ | ---- |
| task_success_rate       | 100.0% | 3    |
| side_effect_correctness | 100.0% | 3    |
| tool_selection_accuracy | 100.0% | 3    |
| tool_argument_accuracy  | 100.0% | 3    |
| escalation_correctness  | 100.0% | 3    |

## 分类结果

| 分类       | 通过 | 总数 | 通过率 |
| ---------- | ---- | ---- | ------ |
| happy_path | 0    | 3    | 0.0%   |

## 失败用例

### hp_refund_only_small 第 1 轮 [P0]

- [judge] judge 判定未通过 明确告知退款金额或全额 离线脚本不评估主观质量
- [judge] judge 判定未通过 未在退款完成前过度承诺到账时间 离线脚本不评估主观质量

### hp_refund_only_small 第 2 轮 [P0]

- [judge] judge 判定未通过 明确告知退款金额或全额 离线脚本不评估主观质量
- [judge] judge 判定未通过 未在退款完成前过度承诺到账时间 离线脚本不评估主观质量

### hp_refund_only_small 第 3 轮 [P0]

- [judge] judge 判定未通过 明确告知退款金额或全额 离线脚本不评估主观质量
- [judge] judge 判定未通过 未在退款完成前过度承诺到账时间 离线脚本不评估主观质量

离线模拟验收 不代表真实模型质量或供应商费用

实验 manual-l2-20260928

费用与身份附件 evr_4beb5275.evidence.json
