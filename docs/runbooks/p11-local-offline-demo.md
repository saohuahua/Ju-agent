# P11 本地离线演示手册

本手册使用正式 API 与当前持久执行器，模型和支付均为本机模拟。默认运行会创建新的系统临时目录，保留业务库、渠道库和恢复证据，不访问默认 `data/app.db`，不调用 `db:reset`，不 build。

## 环境与身份

在 `D:\project\agent-new\aftersales` 执行。需要项目依赖已经安装，Node 能加载现有 tsx 和 better-sqlite3。2026-09-27 本轮实际使用 Node 22.23.2，检查到 pnpm 11.23.0；不将其他历史脚本可能使用的 Node 版本混为本次环境。

```powershell
Set-Location 'D:\project\agent-new\aftersales'
node --version
pnpm --version
```

| 身份 | 演示令牌 | 用途 |
| --- | --- | --- |
| 客户 C1001 | cust-token-1001 | 发起两类退款、补充寄回与查看进度 |
| 客户 C1002 | cust-token-1002 | 验证不能读取 C1001 的进度 |
| 操作员 | operator-token | 确认收货 |
| 主管 | supervisor-token | 作审批决定 |

脚本仅继承运行工具链必需的环境变量，不读取 `.env` 或真实模型凭据。端口由操作系统随机分配，不占用固定的 8787、8790。所有进程归本次脚本管理，不终止其他服务。

## 一条命令完成演示

```powershell
node --import tsx docs/runbooks/p11-demo.ts
```

执行脚本：[p11-demo.ts](p11-demo.ts)。运行开始打印独立目录，例如 `C:\Users\htlocal\AppData\Local\Temp\youju-p11-demo-...`；每个步骤打印一条 JSON，最后输出 `演示通过` 和本次 `summary.json` 路径。正常退出码应为零。

它不是全仓测试，也不运行 L1 数据集。脚本验证新手册的演示步骤和当前本机正式入口，不作为真实模型、真实支付或 Linux 容器验收。

## 演示数据与执行顺序

脚本先在新库调用已有演示初始化，再调整少量基础订单以保持演示可复现。这里只设置测试输入，不预造审批、任务、退款成功或工具结果。

| 基础订单 | 准备条件 | 演示目标 |
| --- | --- | --- |
| SO-2026-0001 | C1001，未发货，29900 分 | 自动批准的仅退款与请求重放 |
| SO-2026-0003 | C1001，已签收，699900 分，签收时间设为本次运行 | 人工审批、寄回、收货与退款 |
| SO-2026-0005 | C1001，未发货，29900 分 | 模拟渠道返回 unknown 时保留未知 |

这些是专用学习夹具，不能用来说明真实商品价格或生产订单结构。基础订单保留在本次库中，后续每一步均从正式接口推进。

1. **启动与就绪。** 打开独立业务库和渠道库，启动 `main.ts`，等待 `/api/ready` 成功。
2. **仅退款与重放。** C1001 发送“SO-2026-0001 未发货 我要退款”，用相同请求键重发，要求返回相同 runId 和 taskId。等待客户进度 succeeded，再验证 C1002 读取该进度得到 403。
3. **审批与退货等待。** C1001 发起 SO-2026-0003 的质量退货，等待 awaiting_approval。主管通过正式审批接口批准，等待 awaiting_shipment，渠道中此时没有该退款记录。
4. **停止并重启原进程。** 使用原数据库启动新 API。客户登记固定演示运单 `P11-LOCAL-RETURN`，同键重放寄回请求。awaiting_receipt 阶段仍不得有资金提交。
5. **收货后退款。** 操作员确认收货，等待 succeeded。渠道中两笔成功退款分别为 submissions=1、charges=1，客户完成事件各一次。
6. **未知故障。** 只在本次独立渠道给下一笔业务设置 unknown，再通过客户接口发起 SO-2026-0005 退款。要求客户进度 unknown，渠道提交一次、成功动作零次。
7. **停写备份与新目录恢复。** 停止 API，调用现有 `p10-data.ts` 保存两库及清单，恢复到新空目录。恢复前后的整体快照相等；新进程中两个成功状态与一个未知状态保持，渠道计数不变。

## 成功判据与输出

不能只看最后一条文字。脚本中的断言同时检查请求身份、客户归属、等待阶段零资金、业务进度、渠道计数、完成事件和恢复快照。

| 输出文件或目录 | 内容 |
| --- | --- |
| summary.json | 本次步骤、运行时间、Node 版本与关键源码哈希 |
| process.log | 本次启动与停止过程输出 |
| original/business/app.db | 原演示业务、任务、事件和费用记录 |
| original/channel/channel.db | 原模拟渠道事实 |
| backup/manifest.json | 两份备份的 SHA256 |
| restored/business、restored/channel | 恢复到的新目录 |
| failure.json | 业务运行阶段失败时的已完成步骤与错误 |

模块加载阶段若失败，可能尚未创建 failure.json，例如缺少依赖。不要因此将“没有 failure.json”当作成功。

本轮实测见[演示证据摘要](../experiments/p11-learning-evidence/demo-summary.json)，验证说明见[P11 文档验证记录](../experiments/p11-learning-validation.md)。临时目录路径仅用于定位本机原始材料，不保证跨机器存在。

2026-09-28 提交前修正脚本响应类型后已再次执行，最新可比源码与结果见[整理后演示摘要](../experiments/p11-learning-evidence/demo-summary-after-cleanup.json)。旧摘要保留历史身份，不混称为新一次执行。

## 查看本次结果并重新打开服务

自动演示完成后，所有本次子进程均已停止。要手动查看恢复后的状态，在一个新的 PowerShell 窗口执行：

```powershell
Set-Location 'D:\project\agent-new\aftersales'
$summaryPath = Read-Host '粘贴本次 summary.json 的完整路径'
$summary = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json
$restoreRoot = ($summary.steps | Where-Object step -eq 'backup-restore').result.restored
$env:P6_BUSINESS_MODE = 'simulation'
$env:P6_EMBEDDED_SIMULATOR = '1'
$env:API_HOST = '127.0.0.1'
$env:API_PORT = '0'
$env:DB_PATH = Join-Path $restoreRoot 'business/app.db'
$env:P6_CHANNEL_DB_PATH = Join-Path $restoreRoot 'channel/channel.db'
$env:OPERATOR_TOKEN = 'operator-token'
$env:SUPERVISOR_TOKEN = 'supervisor-token'
node --import tsx apps/api/src/main.ts
```

保持该窗口运行，复制控制台打印的本机 URL。第二个窗口可以查询已成功或未知的原运行：

```powershell
$base = Read-Host '粘贴本次 API 的 http://127.0.0.1:端口'
$summaryPath = Read-Host '粘贴同一份 summary.json 的完整路径'
$summary = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json
$runId = ($summary.steps | Where-Object step -eq 'unknown-preserved').result.runId
$headers = @{ Authorization = 'Bearer cust-token-1001' }
Invoke-RestMethod -Uri "$base/api/runs/$runId/customer-progress" -Headers $headers
Invoke-RestMethod -Uri "$base/api/runs/$runId/events/json" -Headers $headers
```

未知运行仍应显示 unknown。这里没有提供“一键重新退款”命令，现有正式 `/resume` 入口也不能当作持久业务通用重发开关。核验与重发是不同动作。

## 停止、备份与恢复

手动服务在其控制台按 Ctrl+C 停止。若异常退出，保留数据库，不重置租约或资金许可，下一次仍从原路径启动。Windows 停止行为不作为 Linux SIGTERM 验收证据。

确认没有其他进程写入同一演示库后，可以在保留上述环境变量的窗口做额外备份：

```powershell
$manualBackup = Join-Path (Split-Path $summaryPath) ('manual-backup-' + [guid]::NewGuid().ToString('N'))
node --import tsx scripts/p10-data.ts backup $manualBackup
$manualRestore = Join-Path (Split-Path $summaryPath) ('manual-restore-' + [guid]::NewGuid().ToString('N'))
$env:DB_PATH = Join-Path $manualRestore 'business/app.db'
$env:P6_CHANNEL_DB_PATH = Join-Path $manualRestore 'channel/channel.db'
node --import tsx scripts/p10-data.ts restore $manualBackup
node --import tsx scripts/p10-data.ts integrity
node --import tsx scripts/p10-data.ts snapshot
```

恢复目标两个目录必须为空，哈希不符会拒绝。失败目标保留用于排查，不自动覆盖。自动演示已经验证备份／恢复脚本调用；上面的手工命令提供同一操作的分步形式。

## 常见失败与定位

| 失败 | 定位入口 | 处理 |
| --- | --- | --- |
| Cannot find package 或原生模块加载失败 | 项目已有依赖、Node ABI、进程日志 | 先确认依赖安装与运行时，不临时改业务代码 |
| 启动或就绪超时 | process.log、main.ts、渠道健康 | 检查本次路径权限与子进程错误 |
| 等待业务状态超时 | failure.json、customer-progress、原任务表 | 区分审批未处理、业务拒绝和任务失败 |
| 原审批找不到 | 原 runId、审批列表与执行日志 | 不伪造审批单或跳过批准 |
| 渠道计数增加 | 原请求键、原业务键与执行权 | 保留证据，不删除记录重新获得通过 |
| 恢复目录非空 | p10-data.ts 的目标预检 | 换新的空目录，不清理原业务目录 |

如果主动中断外层脚本，个别平台可能留下子进程。先按本次日志中的端口和命令行确认归属，只处理本次演示进程，不使用全局 `taskkill node`。重新运行脚本会创建新目录，这是新演示，不是恢复旧演示。

## 与网页和 Docker 的关系

本手册的默认命令验证 HTTP 与持久业务，不启动 Next 开发服务器，也不重复前端构建。真实网页的历史演示与截图见[客户寄回验收](../experiments/customer-return-shipment-ui.md)。需要网页时，应单独指定前端 API 地址，并按照已有手册隔离缓存与端口，不能用静态页面代替业务验证。

Docker 的精确操作与待验收项继续以[离线部署手册](offline-deployment.md)为准。P11 演示通过不会将 P10 标成容器验收完成。
