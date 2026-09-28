# 接口与手工演练示例

本章使用与[业务案例](../business/examples.md)相同的虚构订单和金额。每次准备新的隔离数据，避免普通库已有退款或历史签收时间影响步骤。自动完整验证可直接运行 `node --import tsx docs/manual/devops/demo.ts`；下文用于逐步观察和学习。

## 准备与启动独立 API

先在项目根目录运行：

```powershell
Set-Location 'D:\project\agent-new\aftersales'
node --import tsx docs/manual/devops/demo.ts --prepare-only
```

命令输出 directory、original、business、channel，只准备本次临时夹具，不推进售后。复制其中 **original** 的绝对路径，在同一终端继续：

```powershell
$demoRoot = Read-Host '输入刚刚输出的 original 路径'
$env:P6_BUSINESS_MODE = 'simulation'
$env:P6_EMBEDDED_SIMULATOR = '1'
$env:API_HOST = '127.0.0.1'
$env:API_PORT = '0'
$env:DB_PATH = Join-Path $demoRoot 'business/app.db'
$env:P6_CHANNEL_DB_PATH = Join-Path $demoRoot 'channel/channel.db'
$env:OPERATOR_TOKEN = 'operator-token'
$env:SUPERVISOR_TOKEN = 'supervisor-token'
node --import tsx apps/api/src/main.ts
```

保持窗口运行，记录打印的 `http://127.0.0.1:实际端口`。只做接口演练时，在第二个 PowerShell 窗口执行后面的请求。要按截图逐步操作网页，先执行下一节，再从客户申请开始；**不要先运行自动完整演示或后面的申请请求**，否则同一订单已经有售后记录。

## 启动连接本次隔离库的网页

另开一个 PowerShell 窗口执行下列完整代码。它只复制当前前端源码与配置，复用已经安装的依赖，使用独立开发缓存和空闲端口；不 build，不使用日常离线库。

```powershell
$projectRoot = 'D:\project\agent-new\aftersales'
Set-Location -LiteralPath $projectRoot
$apiOrigin = (Read-Host '输入上一窗口打印的本次 API 地址').TrimEnd('/')
$apiUri = [uri]$apiOrigin
if ($apiUri.Scheme -ne 'http' -or $apiUri.Host -ne '127.0.0.1') { throw '此演练仅接受本机 HTTP API' }
$webSource = Join-Path $projectRoot 'apps/web'
$webCopy = Join-Path $projectRoot ('artifacts/manual-web-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $webCopy -ErrorAction Stop | Out-Null
foreach ($name in @('src', 'public', 'next.config.ts', 'next-env.d.ts', 'tsconfig.json', 'postcss.config.mjs', 'package.json')) {
    $source = Join-Path $webSource $name
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $webCopy $name) -Recurse -ErrorAction Stop }
}
New-Item -ItemType Junction -Path (Join-Path $webCopy 'node_modules') -Target (Join-Path $webSource 'node_modules') -ErrorAction Stop | Out-Null
$portProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$portProbe.Start()
$webPort = $portProbe.LocalEndpoint.Port
$portProbe.Stop()
$env:OFFLINE_API_ORIGIN = $apiOrigin
$env:NEXT_TELEMETRY_DISABLED = '1'
Set-Location -LiteralPath $webCopy
Write-Host "打开 http://127.0.0.1:$webPort/workbench"
node (Join-Path $webSource 'node_modules/next/dist/bin/next') dev --turbopack -p $webPort --hostname 127.0.0.1
```

此 PowerShell 方案面向 Windows。副本位于项目 `artifacts` 的下一层，以保持 tsconfig 的相对继承路径有效，且与原项目同盘。依赖目录不存在时先回原项目安装依赖；命令报错时停止，不把页面旧数据当作新环境。

等待 Next 就绪后，打开该窗口打印地址，选择客户张伟，按[完整业务案例](../business/examples.md)的案例二申请 6999 元质量退货。主管在同一地址的 /approvals 审批；客户登记寄回后，仓库收货仍需内部 API。可先加载下一节请求函数，然后查询原客户进度，再确认收货：

```powershell
$manualRunId = Read-Host '输入该客户网页会话对应的 runId'
$manualProgress = (Invoke-ManualApi "/api/runs/$manualRunId/customer-progress" $customer).progress
if ($manualProgress.progress -ne 'awaiting_receipt') { throw '当前不是等待收货 请核对原会话' }
Invoke-ManualApi '/api/operations/receive-goods' $operator @{ returnNo = $manualProgress.returnNo }
Wait-ManualProgress $manualRunId 'succeeded'
```

runId 可从团队“查看关联会话”的详情 URL 获得。结束网页演练时，在本次 Web 和 API 两个窗口各按 Ctrl+C；保留临时双库和前端副本供排查。日常 `pnpm dev:offline` 固定连接日常离线库，不会连接本章临时库。

## 请求与等待函数

以下函数仅用于本机示例，不自动重发写操作。业务进度最多轮询 30 次，每次 HTTP 请求最多等待 10 秒，未完成时再间隔 1 秒；总耗时受请求耗时影响，不保证 30 秒内结束。超时或请求失败会抛错，保留原 runId 排查，不自动新建退款。

```powershell
$ErrorActionPreference = 'Stop'
$base = (Read-Host '输入本次 API 地址').TrimEnd('/')
$customer = 'cust-token-1001'
$operator = 'operator-token'
$supervisor = 'supervisor-token'

function Invoke-ManualApi {
    param([string]$Path, [string]$Token, [object]$Body = $null, [string]$Key = '')
    $headers = @{ Authorization = "Bearer $Token" }
    if ($Key) { $headers['Idempotency-Key'] = $Key }
    if ($null -eq $Body) {
        return Invoke-RestMethod -Uri "$base$Path" -Headers $headers -TimeoutSec 10 -ErrorAction Stop
    }
    $json = $Body | ConvertTo-Json -Depth 10 -Compress
    Invoke-RestMethod -Uri "$base$Path" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 10 -ErrorAction Stop
}

function Wait-ManualProgress {
    param([string]$RunId, [string]$Expected)
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $current = (Invoke-ManualApi "/api/runs/$RunId/customer-progress" $customer).progress
        if ($current.progress -eq $Expected) { return $current }
        if ($current.progress -in @('failed', 'rejected', 'expired', 'unknown')) {
            throw ($current | ConvertTo-Json -Depth 10)
        }
        Start-Sleep -Seconds 1
    }
    throw "等待 $Expected 超时 请保留原运行 $RunId 核验"
}

Invoke-RestMethod "$base/api/ready" -TimeoutSec 10 -ErrorAction Stop
```

## 小额仅退款及请求重放

```powershell
$refundKey = 'manual-refund-' + [guid]::NewGuid().ToString('N')
$refundBody = @{ message = 'SO-2026-0001 未发货 我要退款' }
$refund = Invoke-ManualApi '/api/runs' $customer $refundBody $refundKey
$replay = Invoke-ManualApi '/api/runs' $customer $refundBody $refundKey
if ($refund.runId -ne $replay.runId -or $refund.taskId -ne $replay.taskId) {
    throw '相同请求未返回相同运行与任务'
}
Wait-ManualProgress $refund.runId 'succeeded'
```

预期同键重放不产生新任务，原进度成功。此 API 在持久模式响应 202，最终结果需要继续查询；自动脚本还核对渠道提交与成功计数，手工只查进度不能替代全部判据。

## 大额退货、审批与收货

```powershell
$returnKey = 'manual-return-' + [guid]::NewGuid().ToString('N')
$returnBody = @{ message = 'SO-2026-0003 全部商品 质量问题 我要退货退款' }
$returned = Invoke-ManualApi '/api/runs' $customer $returnBody $returnKey
Wait-ManualProgress $returned.runId 'awaiting_approval'
$approval = (Invoke-ManualApi '/api/approvals' $supervisor).approvals |
    Where-Object runId -eq $returned.runId |
    Select-Object -First 1
if (-not $approval) { throw '没有查到原申请的待审批记录' }
$approval
```

此处先人工核对打印的原审批内容。以下命令会批准本次模拟申请，客户或专员令牌不能代替主管令牌：

```powershell
Invoke-ManualApi "/api/runs/$($returned.runId)/approvals/$($approval.approvalId)/decide" $supervisor @{ decision = 'approved'; decidedBy = 'supervisor' }
$waiting = Wait-ManualProgress $returned.runId 'awaiting_shipment'
$shipmentKey = 'manual-shipment-' + [guid]::NewGuid().ToString('N')
$shipmentBody = @{
    message = '已寄回商品 请核对寄回信息'
    returnShipment = @{
        returnNo = $waiting.returnNo
        trackingNo = 'MANUAL-RETURN-001'
    }
}
Invoke-ManualApi "/api/runs/$($returned.runId)/messages" $customer $shipmentBody $shipmentKey
Wait-ManualProgress $returned.runId 'awaiting_receipt'
```

等待仓库收货阶段尚未退款。只有仓库确认实际收货后，专员提交以下操作：

```powershell
Invoke-ManualApi '/api/operations/receive-goods' $operator @{ returnNo = $waiting.returnNo }
Wait-ManualProgress $returned.runId 'succeeded'
Invoke-ManualApi "/api/runs/$($returned.runId)/events/json" $customer
```

寄回登记重试要保留 `$shipmentKey` 和 `$shipmentBody`。不要复制截图中的售后单号；使用 `$waiting.returnNo`，因为每次演示编号可能不同。

若客户无法自行登记，专员可在同一原单的待寄回阶段使用 `POST /api/operations/return-shipment`，JSON 为 `{"returnNo":"实际售后单号","trackingNo":"实际运单号"}`。它是客户登记步骤的替代方式，不是完成上述登记后必须再执行一次的操作，也不能替代仓库收货。

## 查看、创建与取消离线评测任务

下面命令会向当前 API 数据库写入评测报告和账本，业务夹具由评测器隔离。只在选定演示环境执行。

```powershell
$task = Invoke-ManualApi '/api/eval/run-sim' $operator @{ mode = 'simulation'; caseId = 'hp_refund_only_small'; repeat = 1 }
$task.taskId
$state = $null
for ($attempt = 0; $attempt -lt 120; $attempt++) {
    $state = (Invoke-ManualApi "/api/eval/sim-tasks/$($task.taskId)" $operator).task
    if ($state.status -ne 'running') { break }
    Start-Sleep -Seconds 1
}
if ($state.status -eq 'running') { throw "轮询次数已用完 请保留 taskId $($task.taskId) 继续查询或取消" }
if ($state.status -eq 'error') { throw "评测任务失败 $($state.error)" }
$state
```

task.status=done 只表示报告生成完成，不表示题目全过。读取报告和证据：

```powershell
Invoke-ManualApi '/api/eval/reports' $operator
if ($state.reportId) {
    Invoke-ManualApi "/api/eval/reports/$($state.reportId)/evidence" $operator
}
```

这个用例的离线 Judge 会未通过，业务成功与综合结果应按[评测专章](evaluation.md)解读。需要取消仍在运行的任务时，对 `/api/eval/sim-tasks/{taskId}/cancel` 发 POST，例如 `Invoke-ManualApi "/api/eval/sim-tasks/$($task.taskId)/cancel" $operator @{}`。202 表示接受取消，仍需继续观察任务；任务已经结束或重启后可能返回 404。

## 停止与保留证据

在本次 API 终端按 Ctrl+C 停止，只关闭本次进程。保留临时目录与返回的运行、审批和售后编号。成对备份、恢复和 unknown 故障演练使用[运维说明](operations.md)和自动脚本，不能手改结果字段制造成功。
