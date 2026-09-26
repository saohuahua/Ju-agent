# 执行权模块定向验证

结论 本模块测试通过 不代表全项目资金防线或 P6 整体完成

## 实际命令与结果

工作目录 D:/project/agent-new/aftersales

```powershell
pnpm --config.verify-deps-before-run=false exec vitest run packages/persistence/test/execution-ownership-services.test.ts packages/persistence/test/execution-ownership-repository.test.ts packages/domain/test/after-sale-service.test.ts packages/domain/test/compensation-service.test.ts packages/domain/test/price-protection-service.test.ts
pnpm --config.verify-deps-before-run=false --filter @aftersales/persistence typecheck
pnpm --config.verify-deps-before-run=false --filter @aftersales/domain typecheck
pnpm --config.verify-deps-before-run=false exec eslint packages/contracts/src/execution-ownership-contract.ts packages/domain/src/execution-ownership-guard.ts packages/domain/src/services/after-sale-service.ts packages/domain/src/services/compensation-service.ts packages/domain/src/services/price-protection-service.ts packages/persistence/src/execution-ownership-*.ts packages/persistence/test/execution-ownership-*.ts
```

最终 5 个测试文件 81 条通过

| 文件                                   | 用例数 |
| -------------------------------------- | -----: |
| execution-ownership-services.test.ts   |     25 |
| execution-ownership-repository.test.ts |      5 |
| after-sale-service.test.ts             |     11 |
| compensation-service.test.ts           |     17 |
| price-protection-service.test.ts       |     23 |

domain 和 persistence 类型检查通过 专属文件及三个服务 ESLint 通过
全部本任务文件 Prettier 检查通过 三个既有服务的 git diff --check 通过
已有领域测试验证未注入守卫的兼容模式 新增组合测试才是执行权防线证据

```powershell
pnpm --config.verify-deps-before-run=false exec prettier --check packages/contracts/src/execution-ownership-contract.ts packages/domain/src/execution-ownership-guard.ts packages/domain/src/services/after-sale-service.ts packages/domain/src/services/compensation-service.ts packages/domain/src/services/price-protection-service.ts packages/persistence/src/execution-ownership-*.ts packages/persistence/test/execution-ownership-*.ts docs/handoffs/execution-ownership.md docs/experiments/execution-ownership.md
git diff --check -- packages/domain/src/services/after-sale-service.ts packages/domain/src/services/compensation-service.ts packages/domain/src/services/price-protection-service.ts
```

## 证据范围

| 场景               | 实际验证                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------- |
| 双连接竞争         | 自建两个 Node 子进程 各自打开同一临时 SQLite 文件 IPC 同时放行 旧许可和 P6 接管只有一个成功 |
| 旧路径先得许可     | 三类真实业务服务等待模拟网关期间 P6 接管失败                                                |
| 检查后发送窗口     | 退款服务取得许可后暂停在业务仓储更新 网关调用数为零时 P6 接管仍失败                         |
| P6 接管先完成      | 退款 补偿 价保三个真实服务调用均在网关前失败                                                |
| 收货触发退款       | 实际 receiveReturnGoods 调到守卫 网关零调用 不完成售后单                                    |
| 支付成功但响应丢失 | 模拟渠道先记成功支付再抛错 所有权 unknown 换 runId 重试和 P6 接管均失败 渠道成功次数保持一  |
| 进程退出           | 自建子进程取得许可后直接退出 未释放许可 新连接仍拒绝发送和接管                              |
| 跨运行互斥         | 旧服务两个 runId 重试不重复支付 P6 新请求不能为同一业务键再建运行 原命令可幂等读取          |
| 接管事务回滚       | p6_tasks 插入触发器故意失败 执行权仍为 legacy ready 命令和运行均未遗留 随后旧服务可执行     |
| 发送准备回滚       | 三类 P6 prepare 许可及业务准备后抛错 所有权回到 ready 资金意图不存在                        |
| 成功回写回滚       | 三类 P6 apply 完成后抛错 所有权与业务幂等记录均回滚 原资金效果仍为 unknown                  |
| 成功保留           | 原幂等结果及所有权结果重放不变 成功业务缺少幂等记录也不重发                                 |
| 成功后本地写失败   | 旧服务记录成功事实后幂等写入抛错 成功事实保留 再调用渠道次数仍为一                          |
| 历史与未知         | 历史 created 也冻结 缺失记录不能自动授权 伪造许可无法确认 原许可可确认迟到成功              |
| 同步边界           | 返回 thenable 的受理回调回滚 外层未提交事务中获取旧许可被拒绝                               |

组合测试使用真实领域服务和 SQLite 资金业务仓储 订单 价格 审计及审批辅助夹具使用现有内存仓储
测试未新增审批规则 所有支付都是本地模拟 未访问真实支付渠道
进程实验使用独立 execution-ownership-racer.ts 和系统临时目录 正常测试结束清理临时测试库 不保留数据库快照
进程退出实验验证许可保留窗口 未声称完成正式 Worker 渠道成功后强退恢复矩阵

## 过程中实际发现的问题

首次组合测试三条失败 原因是在结果未知后才重新调用 P6 计划生成器 被原业务状态规则提前拒绝
已将计划固定在旧发送前 再验证未知许可确实拒绝该计划的接管 没有放宽业务规则
首次类型检查发现夹具补偿原因和未知结果 reason 字段不匹配 已修复后通过
本机 python 别名不可执行 已改用现有工具编辑 未安装依赖
沙箱内格式化遇到 EPERM 经工具批准后仅格式化授权文件

未 build 未全仓回归 未读取密钥 未调用付费模型或真实支付
未重置演示库 未启动或停止 8787 和 8790 服务 未提交 Git
