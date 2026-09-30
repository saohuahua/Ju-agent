# P6 故障实验数据汇总

原始运行时间：2026-09-25T14:53:14.998Z

范围：P6 独立组合根进程实验 非正式 API 全链路验收

场景通过数：18 / 18

模型次数来自子进程日志 发送与成功次数来自独立渠道数据库 查询次数来自渠道查询记录
这些计数是确定性故障夹具结果 不能推导生产成功率 性能提升或真实支付效果

| 场景 | 断言通过 | 任务状态与代次 | 业务终态 | POST 次数 | 成功动作 | 查询次数 | 模型次数 |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| [accepted-before-worker](accepted-before-worker/terminal-state.json) | true | completed g1 | succeeded | 1 | 1 | 0 | 1 |
| [before-model](before-model/terminal-state.json) | true | completed g2 | succeeded | 1 | 1 | 0 | 1 |
| [mid-stream](mid-stream/terminal-state.json) | true | completed g2 | succeeded | 1 | 1 | 0 | 2 |
| [after-model-checkpoint](after-model-checkpoint/terminal-state.json) | true | completed g2 | succeeded | 1 | 1 | 0 | 1 |
| [after-payment-response](after-payment-response/terminal-state.json) | true | completed g2 | succeeded | 1 | 1 | 1 | 1 |
| [after-payment-checkpoint](after-payment-checkpoint/terminal-state.json) | true | completed g2 | succeeded | 1 | 1 | 0 | 1 |
| [approval-accepted-exit](approval-accepted-exit/terminal-state.json) | true | completed g1 | succeeded | 1 | 1 | 0 | 1 |
| [channel-response_lost](channel-response_lost/terminal-state.json) | true | completed g1 | succeeded | 1 | 1 | 1 | 1 |
| [channel-rejected](channel-rejected/terminal-state.json) | true | business_failed g1 | failed | 1 | 0 | 0 | 1 |
| [channel-unknown](channel-unknown/terminal-state.json) | true | needs_confirmation g2 | executing | 1 | 0 | 1 | 1 |
| [channel-delayed](channel-delayed/terminal-state.json) | true | completed g1 | succeeded | 1 | 1 | 1 | 1 |
| [intent-before-send-exit](intent-before-send-exit/terminal-state.json) | true | needs_confirmation g2 | executing | 0 | 0 | 1 | 1 |
| [two-workers](two-workers/terminal-state.json) | true | completed g1 | succeeded | 1 | 1 | 0 | 1 |
| [stale-worker-return](stale-worker-return/terminal-state.json) | true | completed g2 | succeeded | 1 | 1 | 0 | 1 |
| [read-timeout](read-timeout/terminal-state.json) | true | call_failed g2 | auto_approved | 0 | 0 | 0 | 1 |
| [cancel-after-send](cancel-after-send/terminal-state.json) | true | cancelled g1 | succeeded | 1 | 1 | 0 | 1 |
| [cancel-long-task](cancel-long-task/terminal-state.json) | true | cancelled g1 | auto_approved | 0 | 0 | 0 | 1 |
| [channel-restart-new-run](channel-restart-new-run/terminal-state.json) | true | completed g1 / completed g1 | succeeded | 1 | 1 | 1 | 1 |

## 分析口径

- completed 只代表本命令完成 资金成功必须同时检查业务记录和渠道成功动作
- needs_confirmation 的成功动作计数为零不等于证明真实资金没有发生 这里只是夹具的已知设置
- mid-stream 的模型次数为二是未确认模型输出的重新获取 不是重复执行资金动作
- 新运行场景有两个任务 只有一个渠道发送和一个成功动作 说明业务键没有绑定运行编号
- 取消后的业务成功表示已发生资金事实已核验 不表示撤销资金或退款回滚
- SSE 正式挂载与旧 Agent 循环改造不在该进程报告的已验证范围
