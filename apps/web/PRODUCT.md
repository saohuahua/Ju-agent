# 有据售后平台

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

客服在工作台处理售后工单，开发者检查 Agent 执行轨迹。客户通过独立入口提交售后问题。

## Product Purpose

将客户会话、实际订单与政策依据、Agent 执行记录和人工处理动作组织在同一工作空间。

## Operating Context

工作台主要面向 1920×1080 及以上桌面屏幕。客服需要连续切换工单并查看对话，开发者需要查看步骤、参数和结果。

## Capabilities and Constraints

沿用现有 HTTP 接口、事件流、权限和业务核验规则。支持内部备注、人工接管、人工回复和受核验约束的结案。前端不编造缺失字段，不将工具调用成功当作业务处理成功。本次不新增普通工单停止执行接口。

## Brand Commitments

保留有据名称。用户明确要求团队后台采用中性白灰主题，蓝色仅用于链接和主按钮。客户入口保留现有主题。

## Evidence on Hand

现有源码和用户提供的三栏参考截图。已确认实施细节见仓库 docs/workspace-redesign-brief.md。
