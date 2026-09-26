# P6 普通会话退款离线实验

日期 2026-09-26

## 范围与环境

只从正式客户 HTTP 路由发起售后 不预置审批单或退款任务 允许初始化原订单 政策 客户夹具 使用独立临时目录 业务库 渠道库和随机本机端口 进程测试保存最终数据库副本及 JSON 证据 不读 .env 或真实密钥 不访问外部模型或真实资金 不启停 8787 或 8790 不 build

起始工作树见 [start-status.txt](p6-conversation-refund-evidence/start-status.txt) Git 基线为 38801d92cc3003b8611576dfc0c7cddff15df686 全部既有改动保留 没有 reset clean checkout 或重新克隆

## 实施期间发现

批量字符串替换方案被自动审批审查拒绝 原因为会覆盖已有未提交的核心源码 命令未执行 改用带上下文核验的逐段补丁后完成 没有绕过审批拒绝

首次类型检查发现测试夹具误用 `snapshotVersion` 和 `getCalls` 分别改用原 `version` 和 `callLog` 接口 首次错误保存在 [first-typecheck.txt](p6-conversation-refund-evidence/first-typecheck.txt) 未修改业务规则或弱化断言

最初 11 项定向业务测试全部通过 随后 6 项真实进程测试全部通过 再补充事务回滚 执行权 租约 模型重试与配对测试 定向阶段日志全部保留 不拼接计算最终全仓测试数

## 验收矩阵

| 场景 | 联合断言 |
| --- | --- |
| 普通客户补问后合法自动批准仅退款 | HTTP 受理与补问 原领域金额 自动持久任务 p6 succeeded 渠道 submissions 1 charges 1 原调用一次 客户完成事件一次 |
| 主管批准前 | 真实客户建单 原审批 pending 渠道零调用 |
| 主管批准 | 原审批消费和业务受理 p6 发送许可 实际渠道 1 次退款 |
| 主管拒绝或过期 | 原退款 cancelled 原调用非成功回填 渠道零调用 |
| 自动或主管批准退货 | 收货前渠道零调用 寄回绑定原 run 与 returnNo 收货 holder 转绑 原退款只执行一次 |
| HTTP 重放 重复模型动作 重复收货 | 返回原请求或领域冲突 submissions 与 charges 均不增加 |
| 越权订单 客户越权 原售后或金额篡改 | 不受理业务或拒绝推进 渠道零调用 |
| sending unknown unassigned 收货 | 保留原授权及状态 不重新获权 |
| 资金未知及人工接管 | needs_confirmation 发送许可保留 仅查询不重发 原调用不伪造成功 |
| 建单受理事务失败 | 售后 退款 执行权与关联全量回滚 |
| 旧会话 Worker 失去租约 | 不写新业务 新代次恢复已确认原动作 不增加模型调用 |
| 发送后取消 | 查询并保留真实退款成功 原调用按事实投影 |
| 网关瞬态重试耗尽 | 三条逐尝试 unknown 各保留 10 微元 Worker attempt 为 1 不叠加调用 |
| 未迁移动作与旧只读快照 | 不进入旧资金服务 不开放退款权限 |
| 跨轮 toolCallId 重用 | 在业务受理前停止 不制造错配结果 |

## 真实进程恢复

全部使用客户 `POST /api/runs` 启动 原审批由该会话创建 再通过正式主管决定接口继续

| 退出点 | 恢复证据 |
| --- | --- |
| before-business-accept | 模型原动作已确认 业务尚未交接 重启复用原轮次 |
| after-business-accept | 自动批准业务与持久任务已原子提交 重启执行 |
| after-approval-accept | 主管批准已消费并受理 重启复用原授权 |
| after-payment-response | 渠道成功 本地尚未记终态 重启查询原交易 |
| before-business-projection | 业务终态已确认 重启仅补原结果与客户事件 |
| return-wait | 退货等待期间关闭进程 重启后客户寄回 运营收货 |

每个场景 assertions 均包含渠道 submissions=1 charges=1 原退款 succeeded 原工具调用结果一次 客户 run.completed 一次 每个场景账本均为 3 条 settled 离线调用 30 CNY micro_yuan 恢复没有重新调用已确认的模型轮次 渠道成功但本地未记账场景还检查 query 记录

模拟价格与 usage 是人工协议夹具 30 微元不是供应商实际收费 六个独立实验库不是生产预算拆分 每个运行与恢复均共用自己的原业务库及原账本 未发生真实模型费用

## 命令与最终状态

```powershell
pnpm --config.verify-deps-before-run=false --filter @aftersales/api exec vitest run test/conversation-refund.test.ts test/conversation-refund-process.test.ts
pnpm --config.verify-deps-before-run=false --filter @aftersales/api exec tsc --noEmit --incremental false
pnpm --config.verify-deps-before-run=false -r test
pnpm --config.verify-deps-before-run=false -r exec tsc --noEmit --incremental false
pnpm --config.verify-deps-before-run=false lint
git diff --check
```

最终全仓单次执行 **586/586 通过** 退出码 0 首次完整运行即通过 日志为 [full-tests-first.log](p6-conversation-refund-evidence/full-tests-first.log) 新增 22 项 HTTP 业务测试及 6 项真实 HTTP 进程测试已包含在 586 项内 不重复相加

| 包 | 通过数 |
| --- | ---: |
| Web | 28 |
| contracts | 15 |
| domain | 92 |
| persistence | 103 |
| tools | 18 |
| workflow | 10 |
| agent | 22 |
| runtime | 121 |
| eval | 60 |
| API | 117 |

全仓禁用增量缓存的类型检查退出码 0 [日志](p6-conversation-refund-evidence/full-typecheck.log) 全仓 ESLint 退出码 0 [日志](p6-conversation-refund-evidence/full-lint.log) `git diff --check` 通过 只格式化本轮修改文件 没有全仓批量格式化

正式离线 L1 使用独立临时评测库运行 **124/124 通过** 该数据集分母与 586 项测试分母分开 [原始日志](p6-conversation-refund-evidence/l1-first.log) [业务报告](p6-conversation-refund-evidence/l1-reports/evr_70cb8d29.json) [费用与身份附件](p6-conversation-refund-evidence/l1-reports/evr_70cb8d29.evidence.json)

```powershell
pnpm --config.verify-deps-before-run=false eval --offline --db <独立临时数据库> --output docs/experiments/p6-conversation-refund-evidence/l1-reports --experiment-id p6-conversation-refund-final-l1
```

L1 账本保留 339 次调用 3390 CNY micro_yuan 无 unknown 或 held 未阻断 数据库归档为 `p6-conversation-refund-evidence/l1.db` 真实模型费用为零 不能将这组离线结果称为真实模型质量成绩

## 最终证据索引

[归档复核摘要与源码哈希](p6-conversation-refund-evidence/final-summary.json) 已只读打开六组归档数据库重新核对退款状态 渠道计数 模型账本及完成事件 并记录本轮 20 个源码与测试文件哈希 [最终工作树状态](p6-conversation-refund-evidence/final-status.txt)

最终全仓执行产生的 HTTP 业务证据目录是 `p6-conversation-refund-evidence/2026-09-26T03-24-17.944Z` 含 22 个场景的渠道 数据库 任务 原工具结果与逐尝试账本记录

最终跨进程证据目录是 `p6-conversation-refund-evidence/process-2026-09-26T03-24-16.876Z` 六个子目录各包含 `application.db` `channel.db` 和 `evidence.json` JSON 同时保留退出时快照 最终任务与执行权 渠道查询记录 客户事件 费用与进程输出

- [交接前退出](p6-conversation-refund-evidence/process-2026-09-26T03-24-16.876Z/before-business-accept/evidence.json)
- [自动受理后退出](p6-conversation-refund-evidence/process-2026-09-26T03-24-16.876Z/after-business-accept/evidence.json)
- [审批受理后退出](p6-conversation-refund-evidence/process-2026-09-26T03-24-16.876Z/after-approval-accept/evidence.json)
- [渠道成功本地未确认](p6-conversation-refund-evidence/process-2026-09-26T03-24-16.876Z/after-payment-response/evidence.json)
- [业务终态尚未投影](p6-conversation-refund-evidence/process-2026-09-26T03-24-16.876Z/before-business-projection/evidence.json)
- [退货等待期间重启](p6-conversation-refund-evidence/process-2026-09-26T03-24-16.876Z/return-wait/evidence.json)

中途定向日志 `directed-first.log` `directed-v2.log` `directed-final.log` 与较早时间戳目录全部保留 最终结论只采用上述完整回归对应的证据

## 边界

仅退款与退货退款为本轮迁移范围 补偿 价保 换货 取消及显式持久模式之外 legacy 资金路径没有全面迁移 P7 全用途真实调用控制未完成 离线模型协议不是质量评测 不解锁 P5 不启动真实实验
