# 售后映射定向验证

日期 2026-09-26

工作目录 `D:/project/agent-new/aftersales`

## 测试结论

新增 `packages/persistence/test/p6-after-sale-mapping.test.ts` 42 条通过，既有 `packages/persistence/test/p6-business.test.ts` 9 条通过，合计 51 条。这是两个定向测试文件的结果，不是全仓或 P6 整体验收。

每个用例使用独立 createMemoryDatabase，测试结束关闭连接。没有磁盘演示数据库清空、真实 Worker 扫描、网络支付、付费模型或服务启停。资金终态用本地 fixture 返回值验证业务回写，不声称验证真实渠道。

覆盖三种售后的审批通过和拒绝、无意图过期、批准后受理前过期、已接管授权过期保护、历史 running 意图拒绝、跨客户和跨案件、金额和币种不一致、退款订单或幂等键错误、政策错误、损坏及非最新断点、令牌错误、收货前禁止资金动作、换货无退款、重复审批受理、重复收货、付款完成后重复收货、等待期间共同篡改金额、缺失或取消授权、伪造收货任务、守卫缺失或拒绝及异步返回。

审批、收货分别在 p6_tasks 插入处注入 SQLite ABORT；过期在审计插入处注入 ABORT。逐表比较售后、退款、审批、意图、命令、任务和审计，验证完全回滚。另验证守卫自身同事务写入也回滚。

## 实际执行命令

为避免 pnpm 启动前依赖自动核对影响范围，直接使用仓库现有二进制，没有安装或改写依赖。

```powershell
./node_modules/.bin/vitest.cmd run packages/persistence/test/p6-after-sale-mapping.test.ts packages/persistence/test/p6-business.test.ts
```

最终执行结果：2 个测试文件通过，51 条测试通过。

独立类型检查使用与 tsconfig.base.json 一致的编译选项，仅将本模块和既有适配回归文件作为入口：

```powershell
./node_modules/.bin/tsc.cmd --noEmit --target ES2022 --module ESNext --moduleResolution bundler --lib ES2022 --strict --noUncheckedIndexedAccess --noImplicitOverride --noFallthroughCasesInSwitch --verbatimModuleSyntax --esModuleInterop --skipLibCheck --forceConsistentCasingInFileNames --resolveJsonModule --isolatedModules packages/contracts/src/p6-after-sale-mapping.ts packages/persistence/src/p6-after-sale-repository.ts packages/persistence/src/p6-business-adapter.ts packages/persistence/test/p6-after-sale-mapping.test.ts packages/persistence/test/p6-business.test.ts
```

结果：退出码 0。

```powershell
./node_modules/.bin/eslint.cmd packages/contracts/src/p6-after-sale-mapping.ts packages/persistence/src/p6-after-sale-repository.ts packages/persistence/src/p6-business-adapter.ts packages/persistence/test/p6-after-sale-mapping.test.ts
```

结果：退出码 0。

格式检查同样只覆盖交付文件：

```powershell
./node_modules/.bin/prettier.cmd --check packages/contracts/src/p6-after-sale-mapping.ts packages/persistence/src/p6-after-sale-repository.ts packages/persistence/src/p6-business-adapter.ts packages/persistence/test/p6-after-sale-mapping.test.ts docs/handoffs/after-sale-mapping.md docs/experiments/after-sale-mapping.md
```

结果：全部匹配文件符合格式，退出码 0。

## 过程中暴露的问题

- 首轮 44 条中 3 条失败，原因为 p6_tasks.approval_id 唯一约束。修正为收货命令引用原审批授权并在发送前校验，没有更改原表或 P6 仓储。补充边界测试后最终 51 条通过。
- 曾执行 `./node_modules/.bin/tsc.cmd --noEmit -p packages/persistence/tsconfig.json`，当时由并行任务文件 `execution-ownership-services.test.ts` 第 66 行和第 177 行的原因枚举及 unknown 结果缺少 reason 报错。没有修改这些文件，也没有将该次包检查记为通过；本任务改用上述独立类型入口完成验证。
- 首次 Prettier 写入因沙箱 EPERM 失败。相同四个授权文件经写入授权后格式化成功，没有扩大修改范围。

## 证据限制

本次是单进程 SQLite 同步事务故障注入，不是跨进程故障恢复实验。真实执行权模块仍由独立任务负责，测试守卫替身不证明新旧执行器互斥。正式路由、收货接口、资金发送接管、审批进度与模型结果回传没有切换。接口与状态表见 [交接说明](../handoffs/after-sale-mapping.md)。
