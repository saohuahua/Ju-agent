# 新旧资金执行权模块交接

本模块已实施并通过定向验证 尚未完成正式迁移和组合根装配 不能作为全项目资金防线验收结论

核验时已有 ConversationJournal DurableConversation 及显式持久普通会话入口 基线匹配
保留所有既有未提交成果 未改写审批映射 业务资格规则或公共入口

## 文件清单

修改既有文件

- packages/domain/src/services/after-sale-service.ts
- packages/domain/src/services/compensation-service.ts
- packages/domain/src/services/price-protection-service.ts

新增专属文件

- packages/contracts/src/execution-ownership-contract.ts
- packages/domain/src/execution-ownership-guard.ts
- packages/persistence/src/execution-ownership-migration.ts
- packages/persistence/src/execution-ownership-repository.ts
- packages/persistence/src/execution-ownership-p6.ts
- packages/persistence/test/execution-ownership-services.test.ts
- packages/persistence/test/execution-ownership-repository.test.ts
- packages/persistence/test/execution-ownership-racer.ts
- docs/handoffs/execution-ownership.md
- docs/experiments/execution-ownership.md

## 业务身份与状态机

复用 refundIdempotencyKey compensationIdempotencyKey priceProtectionIdempotencyKey
分别产生 refund:\<returnNo> compensation:\<compensationNo> price_protection:\<protectionNo>
表主键是 business_key 不包含 runId taskId 或请求键

| 维度        | 值                   | 意义                                     |
| ----------- | -------------------- | ---------------------------------------- |
| owner       | legacy p6 unassigned | 业务执行权归属 历史未核验记录不授权      |
| holder      | 空串或 P6 commandId  | 旧执行器共享业务闸门 P6 绑定一个原命令   |
| state       | ready                | 尚未取得发送许可                         |
| state       | sending              | 发送许可已持久化 可能尚未发送 可能已支付 |
| state       | unknown              | 本地异常 无法证明渠道没有支付            |
| state       | succeeded rejected   | 已确认终态 不允许重新发送                |
| token       | 唯一许可标识         | 确认结果必须匹配业务键 所有者 命令和许可 |
| result_json | 原渠道结果           | 独立于业务表的确认事实 不覆盖原幂等记录  |

允许的迁移

```text
新建业务 → legacy ready
legacy ready → p6 ready             接管与命令受理同事务
legacy ready → legacy sending       旧服务渠道调用前提交许可
p6 ready → p6 sending               与 P6 资金意图同围栏事务
sending → unknown                  旧服务异常 保留原许可
sending 或 unknown → succeeded     原许可对应的渠道成功证据
sending 或 unknown → rejected      原许可对应的明确拒付证据
历史非成功业务 → unassigned unknown
历史成功或幂等结果 → unassigned succeeded
```

没有 sending 或 unknown 回到 ready 的自动转换 没有从 P6 转回旧执行器的接口
不存在按租期 超时或进程存活判断未支付的逻辑
P6 未知结果留在 p6_effects unknown 执行权仍为 sending 两者都禁止重发

## 不变量与崩溃窗口

1. acquireLegacy 使用条件 UPDATE 原子取得唯一发送许可 接管使用 immediate 写事务 二者争用同一个 SQLite 写锁
2. 旧服务取得许可后才写 executing 并调用网关 不存在读取 owner 后直接异步发送的检查窗口
3. acquireLegacy 禁止在未提交的外部事务内调用 防止渠道先发生而许可被回滚
4. P6 接管 命令 任务和运行在同连接同步事务提交 任一步失败全部回滚
5. P6 prepare 回调把许可 业务 executing 和 p6_effects 发送意图放入原有围栏事务
6. P6 apply 回调把执行权终态 业务结果 幂等结果和原检查点放入原有围栏事务
7. sending 后进程退出仍保留许可 即使实际还没调用渠道也不自动释放 这是有意选择安全优先于自动恢复
8. 网关成功后立即保存执行权成功事实 后续业务写入失败不降级为 failed 不因换 runId 再次调用网关
9. 旧业务 succeeded 或已有幂等记录直接读取返回 不删除或覆盖它们
10. 失败重试重新经过同一个许可闸门 旧业务 failed 不代表渠道未发生

新业务创建后登记执行权 这两个步骤尚未合为一个同步事务
如果创建后登记前退出 缺失记录会阻止发送 重启迁移会将其冻结为 unknown 不自动补授权
registerNew 仅供可信的新建服务使用 不是历史修复接口 不得在执行失败 缺少记录或更换运行时调用

## 旧路径装配示例

迁移必须先执行 所有资金服务实例必须使用同一业务数据库的 ExecutionOwnershipRepository
构造函数末尾新增可选参数 原构造参数顺序保持不变

```ts
const executionOwnership = new ExecutionOwnershipRepository(db)
const afterSale = new AfterSaleService(
  orderRepo,
  shipmentRepo,
  returnRepo,
  refundRepo,
  approvalRepo,
  idempotencyRepo,
  gateway,
  noGenerator,
  approvals,
  audit,
  clock,
  executionOwnership,
)
const compensation = new CompensationService(
  orderRepo,
  compensationRepo,
  idempotencyRepo,
  gateway,
  noGenerator,
  approvals,
  audit,
  clock,
  executionOwnership,
)
const priceProtection = new PriceProtectionService(
  orderRepo,
  returnRepo,
  protectionRepo,
  skuPriceRepo,
  idempotencyRepo,
  gateway,
  noGenerator,
  approvals,
  audit,
  clock,
  executionOwnership,
)
```

receiveReturnGoods 仍调用 executeRefund 不新增另一套退款资格规则
被 P6 拒绝的旧收货可能已留下 goods_received 收货事实 但不会调用网关或完成售后单
后续如何把收货事实映射到持久任务由售后审批映射任务处理

## P6 接入示例与准确位置

execution-ownership-p6.ts 提供可直接使用的适配函数 没有修改既有 P6 文件

```ts
const task = acceptExecutionOwnedCommand(db, trustedInput)

const ports = {
  model,
  read,
  payment,
  preparePayment: executionOwnershipPreparePayment,
  applyPayment: executionOwnershipApplyPayment,
}
```

trustedInput 必须来自现有领域资格与审批映射 不可直接信任客户端金额或业务键
没有 payment 的等待或只读命令不接管资金 后续形成真实资金命令时必须再次经过受理包装器
发送前挂到 P6WorkPorts.preparePayment 结果确认挂到 P6WorkPorts.applyPayment
不要仅替换受理入口而保留无守卫的资金 prepare 回调

既有 bridgeApprovals 在同连接 immediate 事务内调用映射器 然后调用原 accept
可由审批映射任务在映射完成后调用本包装器 既有 accept 随后只作相同命令的幂等重放

```ts
tasks.bridgeApprovals((approvalId) => {
  const input = mapApprovedBusiness(db, approvalId)
  acceptExecutionOwnedCommand(db, input)
  return input
})
```

这会让映射中的令牌消费 业务批准 执行权接管 命令受理和意图 running 处于同一个外层事务
全部回调必须同步使用传入的 db 禁止网络调用 异步回调或另开连接
takeoverWithCommand 也可给其他同步映射使用 其回调必须真实受理命令并返回 commandId
本模块只测试真实 accept 和资金回调 没有把上述审批桥接示例当作正式审批集成验收

## 公共迁移与装配清单

| 公共位置              | 主任务待做事项                                                            |
| --------------------- | ------------------------------------------------------------------------- |
| db.ts 统一迁移        | 在既有业务表和 P6 表创建后调用 migrateExecutionOwnership 不清库           |
| 各包 index.ts         | 按实际边界导出契约 仓储 迁移与 P6 包装函数 目前使用源码相对导入           |
| runtime compose.ts    | 给全部三个旧资金服务注入同库 executionOwnership 禁止漏掉另建实例          |
| P6 资金命令与审批受理 | 使用 acceptExecutionOwnedCommand 或同连接 takeoverWithCommand             |
| P6 资金 Worker        | 使用 executionOwnershipPreparePayment 与 executionOwnershipApplyPayment   |
| 旧审批后台任务        | 避免重复消费审批意图 同时保留服务层许可防线                               |
| 测试夹具清理          | 只在明确重置的测试库同步清理 execution_ownership 正式库不得清理以解锁资金 |
| 历史迁移运维          | 切换前停止无守卫旧资金消费者 排空或核验在途 不靠在线建表保证旧进程安全    |

迁移幂等且不重写原表数据 已有所有权行不覆盖
历史 created approved failed executing 等均不据此推断未支付 一律冻结
已有历史 P6 效果同样不自动授权 不能直接恢复历史发送任务以绕过新协议

## 限制与尚未保护入口

- 正式 compose.ts API app.ts 和 db.ts 本任务未修改 因此当前正式装配没有自动启用防线
- 未传入 executionOwnership 的兼容实例仍按旧模式执行 不具备新旧互斥保护
- 直接调用原 P6TaskRepository.accept 原业务 prepare 回调或直接调用网关的路径尚未自动受保护
- 不允许新旧受保护实例与未受保护实例同时处理相同业务数据
- 未实现历史人工核验工具 旧网关接口也没有查询方法 未知结果保持阻塞 不自动重试
- 旧成功事实与业务表写回不是一个事务 本地写回中断可能需要人工核对并补齐业务状态 不允许重发来修复
- 审批令牌校验沿用原代码并位于许可取得之前 竞争失败可能已消费令牌 需映射集成处理审批恢复 本模块不改写审批分支
- 通用 takeoverWithCommand 是可信内部同步接口 同库约束须由调用方遵守 提供的 acceptExecutionOwnedCommand 已固定使用同一连接
- 尚未运行全仓回归 正式 HTTP 资金入口或正式 Worker 全链路验收

测试命令 结果及实验边界见 [模块实验记录](../experiments/execution-ownership.md)
