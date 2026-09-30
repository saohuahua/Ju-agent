# 运维、备份与恢复

## 日常启动和停止

在项目根目录执行 `pnpm dev:offline`，使用实际打印地址。API 改动后停止原启动终端并重新启动；Web 开发服务器热更新不意味着 API 已重载。停止在本次控制台按 Ctrl+C，不全局结束所有 Node 进程。

维护时记录工作区版本、Node 版本、实际端口与数据库路径。当前环境还有独立模拟渠道库，业务库包含会话、审批、持久任务、事件和预算账本。只保留业务库不足以恢复渠道资金事实。

## 备份并迁移到另一台电脑

1. 在启动窗口按 Ctrl+C 停止服务，确认没有其他进程写同一双库。
2. 在仓库根目录运行以下命令，保存终端打印的完整备份路径。

```powershell
pnpm data:backup:offline
```

备份默认写入 `artifacts/offline-backups/`，包含 `business.db`、`channel.db`、`manifest.json`。三份文件一起复制；artifacts 被 Git 忽略，拉取代码不会自动取回数据。也可指定新的空目录：

```powershell
pnpm data:backup:offline 'E:\backups\aftersales-20260928'
```

3. 新电脑取得同版本源码和锁文件，安装依赖。**在首次启动前**恢复备份：

```powershell
$backupPath = Read-Host '输入完整备份目录'
pnpm data:restore:offline $backupPath
if ($LASTEXITCODE -ne 0) { throw '恢复失败 请保留现场 不启动服务' }
pnpm dev:offline
```

恢复先验证两个文件的 SHA256，再检查双库完整性。目标目录已有文件会拒绝，不覆盖原数据。新电脑已启动过时，保留已有项目与数据，另取同版本的完整项目副本，并确认副本的 `data/local-offline` 尚未初始化。下面输入的是这个副本的仓库根目录，不是任意空文件夹：

```powershell
$restoreProject = Read-Host '输入同版本完整项目副本的根目录'
Set-Location -LiteralPath $restoreProject
if (-not (Test-Path 'scripts/local-offline-data.ts')) { throw '目标不是完整项目根目录' }
if (Test-Path 'data/local-offline') { throw '此副本已有离线数据 请保留并改用未初始化的项目副本' }
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败 停止恢复' }
$backupPath = Read-Host '输入完整备份目录'
pnpm data:restore:offline $backupPath
if ($LASTEXITCODE -ne 0) { throw '恢复失败 请保留现场 不启动服务' }
pnpm dev:offline
```

`data:restore:offline` 的目标固定为**该脚本所在项目**的 `data/local-offline`；仅切换到空目录，或设置 `DB_PATH`、`P6_CHANNEL_DB_PATH`，都不能改变该包装命令的目标。原工作区有未提交实现时，新副本还须包含这些对应源码，不能只按旧提交号重新克隆。不要删除现有库来消除报错。

恢复后先查 ready，再进入原客户会话核对状态、审批、寄回和未知记录。数据库能打开、页面返回 200 都不足以证明业务恢复正确。需要演练可运行 [demo.ts](demo.ts)，其恢复阶段核对整体快照及渠道计数。

## 独立演示的数据工具

仅针对本次演示脚本打印的目录，停止其 API 后，可用 `scripts/p10-data.ts` 操作明确指定的双库。以下输入的是 `original` 目录，不是 summary 文件或单个数据库文件：

```powershell
$demoRoot = Read-Host '输入本次演示 original 目录'
$env:DB_PATH = Join-Path $demoRoot 'business/app.db'
$env:P6_CHANNEL_DB_PATH = Join-Path $demoRoot 'channel/channel.db'
node --import tsx scripts/p10-data.ts integrity
node --import tsx scripts/p10-data.ts snapshot
$manualBackup = Join-Path (Split-Path $demoRoot) ('backup-' + [guid]::NewGuid().ToString('N'))
node --import tsx scripts/p10-data.ts backup $manualBackup
```

恢复到新目录时，先将两个环境变量改到该新目录中的 business/app.db 与 channel/channel.db，再执行 `node --import tsx scripts/p10-data.ts restore $manualBackup`。完整自动演练已经验证这一操作，手工操作仍应检查实际路径及退出码。

不要复制运行中的 SQLite 主文件作为备份，WAL 日志可能包含尚未合并的已提交数据。普通恢复不使用 `db:reset`、`down -v`、手工清理退款记录或租约。

## 常见故障处理

| 现象                       | 排查顺序与处理                                                            |
| -------------------------- | ------------------------------------------------------------------------- |
| 页面打不开                 | 确认终端实际地址及本次进程；端口冲突时使用启动器选择的新地址              |
| health 正常但 ready 失败   | 查看 API 输出、基础数据和模拟渠道健康；旧库部分缺数据不会自动重播夹具     |
| Cannot find package        | 确认工作目录及 workspace 依赖安装，不修改业务状态                         |
| better-sqlite3 加载失败    | 核对 Node 版本、系统与原生依赖，不跨系统复制 node_modules                 |
| 已发送却无新回复           | 查询原 runId 的 events/json、任务状态和代理 SSE；别用新请求键不断重复提交 |
| 等待审批                   | 主管处理原申请，客户或专员不能越权批准                                    |
| 等待收货                   | 查询原 returnNo 和寄回记录，由仓库确认后提交内部收货                      |
| unknown、人工结案被阻止    | 核对原资金身份、执行意图和渠道事实；保留未知，不将超时改写为失败或成功    |
| `/resume` 返回 409         | 当前持久任务由 Worker 恢复，不走旧断点恢复入口                            |
| 评测报告看不到             | 确认 CLI 库与 API 库是否相同；默认并不相同                                |
| 评测预算阻断或来源校验失败 | 保留账本及源码清单，按评测章节定位，不清库求通过                          |
| restore 拒绝               | 核对目标是否空、备份是否成对、哈希是否一致；保留失败现场                  |

模型费用未知与退款资金未知是两类记录。前者是调用费用不能确定，后者是资金副作用不能确定，不能用客户页面的退款结果推断模型费用。

## Docker 部署

已有 Compose 和 Dockerfile，但本机容器构建与完整验收尚未完成。前置检查、构建、启动、双卷恢复及验收命令以[离线部署手册](../../runbooks/offline-deployment.md)为准；本轮没有执行 Docker build，也不将当前文档交付视为容器部署成功。

本地开发使用 Windows 原生依赖与 Next 开发进程，容器使用 Linux 依赖和生产构建。更新镜像后仍需验证同源 API、SSE、权限、持久任务恢复和双卷备份。生产认证、真实支付及公网部署不在当前实现的验收范围内。
