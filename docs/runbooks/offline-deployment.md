# 默认离线部署与恢复

2026-09-28 接续状态：Docker 安装及旧套接字阻塞已处理，但固件虚拟化检查为未启用，WSL2 报 `HCS_E_HYPERV_NOT_INSTALLED`，Windows 组件也需要重启；容器构建和验收仍未完成。BIOS 开启 SVM 后的检查与接续命令见[本次部署记录](../handoffs/p10-deployment-resume-20260928.md)。

本入口默认用于本机离线演示，启动时真实模型和真实资金均不启用。代码允许从本机设置页显式测试并启用真实模型对话，业务和资金仍为模拟；该可选路径尚未在 Docker 容器实测，见[模型设置手册](model-settings.md)。当前容器运行验收受阻，不能据本文命令宣称已部署成功。身份仍为演示令牌，不适合公网、生产认证或真实售后。

## 前提与默认命令

在仓库根执行。要求本机 Linux 容器 daemon、Docker Compose v2、可用的 18790/18787 端口。只使用本机 Docker context，不连接未知远端。不需要 PostgreSQL、Redis、模型密钥或旧实验包。首次构建需要镜像仓库、npm 和 Debian 包源网络，或预先准备的缓存；运行离线不等于首次安装依赖可以凭空断网完成。

```bash
docker context inspect
docker version
docker compose version
docker info
docker compose --env-file infra/docker/offline.env -p youju-p10 -f compose.yaml config --quiet
docker compose --env-file infra/docker/offline.env -p youju-p10 -f compose.yaml build
docker compose --env-file infra/docker/offline.env -p youju-p10 -f compose.yaml up -d --wait
docker compose --env-file infra/docker/offline.env -p youju-p10 -f compose.yaml ps
curl http://127.0.0.1:18790/api/health
curl http://127.0.0.1:18790/api/ready
docker compose --env-file infra/docker/offline.env -p youju-p10 -f compose.yaml logs --tail 100 api web
```

PowerShell 可用 `Invoke-RestMethod` 代替 curl。浏览器访问 `http://127.0.0.1:18790/workbench`，选择客户身份。基础订单 SO-2026-0001 可输入“未发货 我要退款”，原基线金额需要主管审批。历史签收日期按原业务规则判断，不保证多年后仍在退货窗口；验收脚本仅在独立新卷调整基础订单日期和金额。

显式空 `offline.env` 防止 Compose 自动载入仓库 `.env`，Compose 不配置 env_file，也不透传模型凭据。镜像基底固定 Node 22.23.2，pnpm 固定 11.23.0，`--frozen-lockfile` 安装全部 workspace 依赖，保留 TS 源码导出和根 tsx。better-sqlite3 锁定解析为 11.10.0，在 Linux Debian/glibc 基底安装，带 Python/make/g++ 作为原生编译回退，并在构建时真实打开内存库；没有复制 Windows node_modules。镜像 tag 固定但未锁 digest，尚不声称位级可重复构建。

`.dockerignore` 使用白名单，只传应用源码、包源码和必要构建配置。没有数据库、环境文件、真实凭据、Git 历史或 docs 实验档案。未做生产依赖裁剪，以避免当前源码 workspace 导出与 tsx 链路被剪断。

镜像构建安装依赖后自动运行 `scripts/p10-source-manifest.ts` 生成 `/app/.p10-source.json`，API 的 `P9_SOURCE_MANIFEST` 指向它。正式评测会重新计算受控文件哈希并比对清单，因此无 Git 也能保存可核验来源。Git 提交和脏树状态记录为 null，不伪造干净提交；清单缺失或源码不一致返回 `503 SOURCE_IDENTITY_UNAVAILABLE`。此时应修正构建产物并重建镜像，不要移除校验或在运行中的 API 内重写清单。源码工作区未设置该变量时仍使用原 Git 来源模式。

## 网络和数据

| 服务 | 监听与路径 | 数据归属 |
| --- | --- | --- |
| Web 生产进程 | 容器 0.0.0.0:8790 → 宿主 127.0.0.1:18790 | 生产 `.next` 构建，不保存业务库 |
| 正式 API 与 Worker | 容器 0.0.0.0:8787 → 宿主 127.0.0.1:18787 | `business:/data/business/app.db` 含业务、任务、事件、P7 账本 |
| 原渠道模拟器 | API 同一 Node 进程，随机 127.0.0.1 端口，不发布 | `channel:/data/channel/channel.db` 含 submissions、charges 和故障记录 |

浏览器 `/api` 和 SSE → Web 同源 rewrite → `http://api:8787/api` → 原回环支付客户端 → 原模拟器。API 与模拟器同进程只共享网络和生命周期，不共享库；没有第二套支付服务。容器端口需对容器网络开放，宿主映射只绑定回环。

Web 客户端统一使用同源 `/api` 路径，构建产物保存内部 API rewrite。代理在 `OFFLINE_DEPLOYMENT=1` 时默认转发到容器网络中的 `http://api:8787`；本地 `pnpm dev:offline` 则把 `OFFLINE_API_ORIGIN` 设置为本次启动的 API 地址。独立运行 `pnpm dev:web` 时，同源 `/api` 代理到宿主机 `127.0.0.1:8787`，局域网浏览器无需访问自己的回环地址。生产环境更改代理目标需要重建 Web 镜像，不能让浏览器直接解析容器名。

api/web 均以 node 用户运行，镜像内预建并赋权两个数据目录，首次新 named volume 继承目录内容与权限。新卷实际权限、Linux 原生库和重建读取必须在 Docker 环境验收；不要把 bind mount 未授权目录的失败用常驻 root 绕过去。

`/api/health` 是存活，`/api/ready` 还检查数据库基础数据和渠道 `/health`。探针不提交支付，不写渠道查询记录，不调用模型、不清理费用。停止中的入口返回 503。

## 初始化和停止

每次启动复用原 `openDatabase/migrate` 增量迁移。首次全库所有应用表都为空时，原 loadFixture 在一个立即事务中播种，嵌套清理用保存点；失败全量回滚。任何表已有数据都返回 existing，包括无订单但有任务或费用的库。旧库不会自动补齐部分夹具；缺基础数据时 readiness 不通过，应先备份并人工核验缺失原因，禁止用 reset 修复未知资金库。

SIGTERM 停新接入并中断 SSE/套接字，等待原两个 Worker 当前任务结束，然后关闭渠道监听及两个数据库。进程内 15 秒超时失败退出，Compose 给 20 秒；超时或 SIGKILL 不改租约、执行权、未知资金或 P7 费用占位，重启沿用原恢复机制。Windows kill 不是 Linux SIGTERM 的等价验证，容器退出日志仍待实测。

```bash
docker compose --env-file infra/docker/offline.env -p youju-p10 -f compose.yaml stop
docker compose --env-file infra/docker/offline.env -p youju-p10 -f compose.yaml up -d --wait
docker compose --env-file infra/docker/offline.env -p youju-p10 -f compose.yaml down
docker compose --env-file infra/docker/offline.env -p youju-p10 -f compose.yaml up -d --wait
```

stop/down 均保留 named volumes；普通路径绝不使用 `down -v` 或 `db:reset`。清空属于另一个显式破坏性操作，不在本手册默认路径中。

## 两库一致备份和恢复到新卷

先停止两个服务，确保没有其他进程写入相同卷。不能只复制运行中的主 db；WAL 可能持有已提交数据。下面辅助容器不启动服务，使用原 SQLite backup API 保存两库及 SHA256 manifest。两库必须成对来自同一次停写区间，跨库没有联合事务快照保证。

PowerShell 示例，选择一个新的备份目录：

```powershell
$p10backup = Join-Path (Get-Location) 'artifacts/p10-backup-20260926'
New-Item -ItemType Directory -Path $p10backup
docker compose --env-file infra/docker/offline.env -p youju-p10 -f compose.yaml stop
docker compose --env-file infra/docker/offline.env -p youju-p10 -f compose.yaml run --rm --no-deps -v "${p10backup}:/backup" api node --import tsx scripts/p10-data.ts backup
docker compose --env-file infra/docker/offline.env -p youju-p10-restore -f compose.yaml run --rm --no-deps -v "${p10backup}:/backup" api node --import tsx scripts/p10-data.ts restore
docker compose --env-file infra/docker/offline.env -p youju-p10-restore -f compose.yaml run --rm --no-deps api node --import tsx scripts/p10-data.ts integrity
$env:P10_WEB_PORT = '28790'
$env:P10_API_PORT = '28787'
docker compose --env-file infra/docker/offline.env -p youju-p10-restore -f compose.yaml up -d --wait
```

restore 预检两个目标目录均为空，并核对两个备份哈希；目标已有文件则拒绝，不覆盖已有 WAL。复制中断后保留失败目标，换新的测试 project 重做，不把残留目标当成功恢复。恢复后使用 snapshot 比较原 task/command/toolCall、客户事件、两类账本和渠道计数，不能仅看 integrity 或 HTTP 200。Linux 宿主备份目录须允许容器 node UID 1000 写入。不要同时让两个实例使用同一业务卷。

## 验收命令

先按默认命令构建两个镜像，再在已装依赖的仓库运行：

```bash
pnpm --config.verify-deps-before-run=false exec tsx scripts/p10-acceptance.ts
```

脚本只接受本机 npipe/unix Docker context，创建独立 `p10-accept-*` project，使用 28787/28790 和新卷。端口已占用则失败，不结束其他服务。覆盖正式 HTTP 两类退款、重放、等待期杀容器和重建、原 toolCall 与客户事件、未知资金/费用、接管 409/普通留言/越权 403、停写备份、新 project 恢复和业务模式 live 拒绝。此处的业务模式拒绝不等于本机设置页无法启用真实模型传输。最后通过已有 puppeteer-core 对实际容器页面做同源 API/SSE 和桌面/窄屏截图检查；需要本机 Chrome/Chromium，可用 `P10_BROWSER_EXECUTABLE` 指定，不自动安装。没有运行浏览器就不能标记整套容器验收通过。

结果写 `artifacts/p10/<时间>/`，失败也保留，完成后停止本轮服务并保留所有卷。不要将完整 JSON、库和截图自动提交。故障矩阵另复用已有 `apps/api/test/conversation-refund-process.test.ts`，不重写资金恢复框架。

没有 Docker 时可运行下列补充验证，但不能替代容器验证：

```bash
pnpm --config.verify-deps-before-run=false exec tsx scripts/p10-acceptance.ts --local
pnpm --config.verify-deps-before-run=false exec tsx scripts/p10-build-web.ts
```

local 模式使用新临时库和随机本机端口，实际启动 main.ts；生产构建脚本在白名单复制目录构建，复用已安装依赖，不复制或读取源环境文件。完整阶段结果见 [P10 实测](../experiments/p10-offline-deployment.md)。
