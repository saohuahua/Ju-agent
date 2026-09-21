# 失败 Trace 06 cl_missing_order_no 补问未走工具与调用超限

- 用例 [packages/eval/src/cases/clarification.ts](../../packages/eval/src/cases/clarification.ts)
- 类别 clarification P0 断言补问事件 退款完成 工具调用 ≤ 5
- 修复状态 复验通过 27s 修复由 agent 侧结构性变更承载 未打用例级补丁
- 证据 `eval/failures/cl_missing_order_no-*.json` 共 2 轮导出 全败

## 失败轨迹

**R1 纯文本补问 未调 ask_user**
> 顾客: 你好 我想退款 我最近下的一个订单不想要了
> 客服: 您好 李女士 我查到您名下共有 3 笔订单 为了帮您办理退款 麻烦您提供一下想退的那笔订单的订单号
> 断言: 期望出现补问暂停 事件中未发现 | 必须调用的工具 get_order 未被调用 | 无退款记录

模型用纯文本提问结束了回合 没有调用 ask_user 工具 补问检查点事件缺失 后续链路未继续

**R2 链路全通 但工具调用超限**
> 客服: 已为您办理好退款 退款单号 RF-2026-0002 退款金额 ¥89.00 原路退回微信支付
> 断言: 工具调用 6 次超过上限 5

退款闭环完整 唯一失败是轨迹断言 maxToolCalls 5 被打破 多了一次冗余调用

## 根因分析

| 层 | 缺陷 |
| --- | --- |
| 工具纪律 | 补问必须走 ask_user 工具才能产生检查点事件 纯文本提问绕过了结构化机制 对话状态无法被系统感知 |
| 调用冗余 | 模型在宽工具目录下产生投机性冗余调用 超出轨迹上限 |

## 修复与验证

未做用例级修改 由 agent 侧结构性收紧承载
- `packages/agent/src/agent.ts` prepareStepTools 能力门控 动作工具在订单未加载前不进目录 补问阶段模型可见工具集收窄 减少投机调用
- 既有提示词规则 2(需要用户提供信息时必须调用 ask_user)在收窄目录下成为更自然的路径

诚实声明 该用例未经历逐轮迭代修复 复验单轮通过(27s) 真实模型行为存在随机性成分 稳定性验证留待全量 L2 Pass^k 多轮

## 复现命令

```bash
pnpm eval:sim -- --case cl_missing_order_no
```
