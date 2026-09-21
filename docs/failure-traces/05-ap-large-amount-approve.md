# 失败 Trace 05 ap_large_amount_approve 审批恢复后模型读到陈旧状态

- 用例 [packages/eval/src/cases/approval.ts](../../packages/eval/src/cases/approval.ts)
- 类别 approval P0 断言审批 approved 退款执行 且客服告知最终审批结果
- 修复状态 已修复 复验通过 35s
- 证据 `eval/failures/ap_large_amount_approve-*.json` 共 8 轮导出 7 败 1 过

## 失败轨迹

**R1 开局反复问号** 顾客未提供订单号 模型只问号不推进
> 客服: 为了帮您查询未发货订单的具体情况 请您提供一下相关的订单号
> judge: 对话中客服仅询问订单号 全程未提及退款 审批流程或审批结果相关内容

**R2-R7 审批恢复后重复等待话术** 业务断言全过(退款已执行) 但客服从不告知最终结果
> 客服: 退款申请已进入审批环节 我暂时无法向您承诺到账时间 审批通过后我们会第一时间告知您
> judge: 客服仅说明需要人工审批 但未给出最终审批结果 反而说请您留意后续审批结果通知 说明审批结果尚未产生

**R8 模型行为已修复 但 judge 输出不可解析**
> judge 判定未通过 judge 输出无法解析 [{…"reason":"客服仅说明退款"已提交并通过系统审批" 未提及大额退款需要人工审批…"…}]
> reason 内引用对话原文时使用了未转义的英文双引号 JSON.parse 直接抛异常

## 根因分析

| 层 | 缺陷 |
| --- | --- |
| workflow 断点续跑 | resumeAfterApproval 跳过 COMPLETED_STEPS 直接从断点恢复 断点处 state.policyOutcome 仍是历史的 needs_approval 模型可感知的摘要带着陈旧状态 模型据此判断「还在等审批」继续输出等待话术 |
| judge 解析脆弱性 | judge 在 reason 里转述对话原文 使用英文双引号且未转义 产出非法 JSON 解析失败被判 judge 失败 用例失败(保守方向) 但掩盖了真实模型行为已经正确的事实 |

第一个是引擎级状态一致性问题 第二个是评测工具链鲁棒性问题 两者都修完用例才通过

## 修复

1. `packages/workflow/src/engine.ts` resumeAfterApproval approved 分支在 runSteps 后覆写 summary policyOutcome 显式置为 approved 消除模型可见的陈旧状态
2. `packages/agent/src/prompt.ts` 工具使用约束追加 审批决策恢复后必须先以文本告知最终结果 金额与到账渠道 再调用 conclude
3. `packages/eval/src/judge.ts` 双保险
   - judge 系统提示词规则 5 reason 内引用对话原文用「」或单引号 禁止英文双引号
   - parseVerdicts 正则兜底 逐项提取 rubric/passed/reason 兼容 reason 内含未转义双引号的非法 JSON 兜底仍失败时判 judge 失败 保守方向不变

## 复现命令

```bash
pnpm eval:sim -- --case ap_large_amount_approve
```
