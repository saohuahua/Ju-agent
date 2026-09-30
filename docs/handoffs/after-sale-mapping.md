# 售后审批与持久计划映射交接

日期 2026-09-26

## 交付范围

独立内存组合根已验证 return_request 的审批通过、拒绝、过期、退货等待和收货映射。不是 P6 整体完成，也没有切换正式路由、启动后台扫描、调用真实付款或向模型回传最终结果。

已核对当前 ConversationJournal、DurableConversation、AfterSaleService、ApprovalService、政策引擎、状态机、审批仓储和 P6 仓储。既有未提交成果保留，三个业务服务及所有禁止修改的公共文件未由本任务修改。

## 原业务事实与映射原则

- AfterSaleService 创建非换货售后时已经预留 refunds，映射不新建退款记录。
- 原政策引擎对换货也保留商品金额并应用大额审批阈值。换货审批金额不必为零，但不能据此创建退款。
- 退货和换货必须经过 awaiting_buyer_shipment → buyer_shipped → goods_received。不能把审批通过视作已收货。
- 原换货服务在收货后把售后标记 completed，重发货物由仓储负责。本模块保持该语义，没有实现真实重发。
- ApprovalService 的过期返回不一定创建执行意图，因此过期终止使用独立入口。
- p6_tasks.approval_id 具有唯一约束。审批任务占用该关联；收货任务通过 requestPayload.approvalId 引用原持久授权，不修改约束或复用原任务执行资金。

## 分支状态表

共同审批前置条件是资源属于同一客户和运行、运行 awaiting_approval、售后 awaiting_approval、政策 needs_approval、金额与审批及最新断点一致。退款单号、订单、金额、币种和原业务键必须与售后单匹配。最新断点还需包含一致的 approvalId、approvalResourceType、returnNo、refundNo、refundAmountCents、policyOutcome、requiresApproval 和未消费 approvalToken。

| 分支和输入                    | 额外前置条件                                                     | 同事务状态变化                                                       | 持久计划与下一步                                             |
| ----------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| 仅退款批准 approvalId         | approved 决定及 pending 意图 令牌未过期 原退款 created           | 消费令牌 售后 awaiting_approval → approved 意图 → running            | 原退款资金计划 使用 refundNo 与 refund:returnNo 等待受控执行 |
| 退货批准 approvalId           | 同上                                                             | 消费令牌 售后 → approved → awaiting_buyer_shipment 意图 → running    | after_sale_wait 无 payment 等待买家寄回                      |
| 换货批准 approvalId           | 同上 不能存在退款记录                                            | 同退货批准                                                           | after_sale_wait 无 payment 无退款 等待买家寄回               |
| 三类拒绝 approvalId           | rejected 决定及 pending 意图                                     | 清空令牌 售后 → rejected 原退款 created → cancelled 意图 → running   | 无资金后续记录命令 后续任务完成不代表支付成功                |
| 三类未受理审批过期 approvalId | pending 或 approved 已到期 或明确 expired 意图为空或 pending     | 清空令牌 售后 → expired 原退款 → cancelled pending 意图 → failed     | 不创建任务 审计保留终止原因                                  |
| 退货收货 P6AfterSaleReceipt   | buyer_shipped 原持久审批授权有效 最新断点绑定一致 原退款 created | 售后 → goods_received 与收货任务同时提交                             | 使用同一 RF 单和 refund:returnNo 原审批配置 不二次消费令牌   |
| 换货收货 P6AfterSaleReceipt   | buyer_shipped 原持久审批授权有效 无退款                          | 售后 → goods_received → completed 与收货任务同时提交                 | 无 payment 记录换货收货完结 重发由原仓储流程负责             |
| 退款成功确认                  | Worker 围栏和执行权守卫通过 渠道终态确定                         | 原退款 executing → succeeded 售后 → completed 写原业务幂等记录与审计 | 不重新生成资金动作 模型结果回灌由集成任务负责                |
| 重复审批或重复收货            | 已存在本映射的同键命令 不可变业务绑定一致                        | 无新增变更                                                           | 返回原 taskId 不再次消费授权 不生成第二笔资金动作            |

过期处理不会把已批准审批改写为 expired，因为既有审批状态机没有 approved → expired。已批准事实保留，清空未消费令牌并终止售后和意图。已受理的持久授权不会因等待寄回跨过令牌有效期再次消费或被过期扫描撤销。历史 running 意图没有本映射命令时不自动重放，交人工核验。

## 接口与事务边界

源码使用相对导入，没有修改包 index 或依赖声明。

| 接口                                                           | 职责与调用方式                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| p6ApprovalCommand(db, approvalId, config, afterSaleGuard)      | 原补偿价保映射保持兼容 return_request 委托专属映射 守卫缺失即拒绝 必须放在 bridgeApprovals 的事务回调内 |
| p6AfterSaleApprovalCommand(db, approvalId, config, guard, now) | 内部有写入的映射函数 不得当作只读预览 只在同步受理事务内调用 异常必须向外传播以回滚                     |
| new P6AfterSaleRepository(db, guard, now)                      | 独立组合根 同库同步守卫是必填参数 now 是可注入时钟                                                      |
| acceptApproval(approvalId, config)                             | 单审批受理的 immediate 事务 包含令牌消费 业务推进 守卫 命令任务 意图状态 不扫描其他业务                 |
| expireApproval(approvalId)                                     | 独立 immediate 事务覆盖无执行意图的过期审批 不接管 running 意图 不撤销已持久消费的授权                  |
| receive({ approvalId, runId, customerId, returnNo })           | 同库 immediate 事务收货与任务受理 不接收金额 不调用旧 receiveReturnGoods 或 executeRefund               |
| p6AfterSalePaymentApproval(db, payment, task)                  | 发送前追溯已落库审批命令及收货命令 校验原授权金额和资源 不接受仅有空令牌的旧历史记录                    |

收货只服务本模块已经持久受理的需审批售后。政策 allow 的无审批收货仍属于后续接入范围。调用方必须是已鉴权且能确认真实收货的仓储或运营入口；customerId 只是业务绑定字段，不是身份凭据。

当前收货继续使用原审批运行和配置，最新断点必须仍提供同资源绑定字段。普通 DurableConversation 的未来动作断点格式如不同，必须显式适配，不能删除校验或回退读取旧断点。该接口不负责改写会话状态、追加客户消息或动作 tool_result。

## 执行权连接位置

本模块没有执行权表、锁、租约或资金扫描器。P6AfterSaleGuard 只有同步接入契约：`(db, context) => void`。context 包含 phase、approvalId、runId、customerId、returnNo，以及非换货的 refundIdempotencyKey 结果。没有默认放行实现。测试替身只验证事务，不能接入正式环境。

1. p6AfterSaleApprovalCommand 的 approval 守卫：所有绑定核验后、令牌消费前。同一连接同一事务内完成执行权取得或核验，再进行业务批准和任务受理。退货等待也必须锁定原业务的执行归属，防止旧收货路径立即付款。
2. receive 的 receipt 守卫：原持久授权及 buyer_shipped 校验后、goods_received 写入前。核验原执行权，不另建收货退款执行权记录。守卫、收货、命令和任务必须一起提交或一起回滚。
3. expireApproval 的 expiry 守卫：终止业务前阻止与旧执行器竞争。已经 running 的未知历史意图在调用守卫前就拒绝自动接管。
4. 正式 Worker 的 preparePayment 回调：必须在 P6TaskRepository.beginPayment 已有围栏事务内先调用执行权模块的发送守卫，再调用 p6PrepareBusinessPayment。异步渠道发送只能在受控资金意图提交后发生。不可在事务外先查权再发送。
5. 正式 Worker 的 applyPayment 回调：执行权结果守卫与 p6ApplyBusinessPayment、P6 资金结果及步骤检查点共用原 settle 围栏事务。

守卫抛错必须中止整个事务，不能 catch 后继续受理。守卫不能返回 Promise，也不能在另一个连接或外部事务提交执行权。测试已验证守卫同步写入随任务插入失败回滚；真实新旧执行器互斥由另一个任务验收。

## 公共文件接入清单

| 所有者位置                        | 后续接入要求                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| packages/contracts/src/index.ts   | 如需包公开接口 导出 p6-after-sale-mapping 契约                                                               |
| packages/persistence/src/index.ts | 导出专属仓储与守卫类型 不新增迁移                                                                            |
| packages/runtime/src/compose.ts   | 同库装配真实执行权守卫和 P6AfterSaleRepository 连接 preparePayment 和 applyPayment 守卫                      |
| apps/api/src/app.ts               | 主管决定仍走原 ApprovalService 对目标意图进行安全受理 过期显式终止 收货需要运营鉴权 不启动旧后台处理同一业务 |
| 原寄回与收货入口                  | 登记寄回可沿用原受控流程 收货切换为独立仓储事务 禁止同时调用会直接付款的旧收货服务                           |
| P6 Worker 与扫描生命周期          | 资金执行权接管验收前不开启真实扫描 after_sale_wait 只表达业务等待 当前 P6 没有新增等待状态                   |
| 审批进度与结案读模型              | 收货任务通过命令载荷引用审批 原审批任务完成不等于退货退款完成 须追溯收货任务和原业务状态                     |
| 会话恢复与事件投影                | 映射结果回灌动作 tool_result 与客户事件 同事务关联当前会话断点 属于集成任务                                  |

db.ts、schema.ts、p6-task-repository.ts、p6-worker.ts、conversation-journal.ts、durable-conversation.ts 均无需为本独立模块修改。package.json 与锁文件没有新增依赖。

## 验证与未完成边界

实际命令、失败修正和结果见 [定向验证记录](../experiments/after-sale-mapping.md)。未运行全仓回归或 build，未操作演示库或 8787 与 8790 服务，未读取密钥、调用付费模型或真实支付。

正式路由切换、真实执行权互斥、收货身份接入、会话最新动作断点契约、最终结果回传与收货任务读模型仍需集成。独立模块通过不代表这些边界已经通过，也不解锁 P5。
