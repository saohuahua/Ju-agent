# P10 部署接续记录 2026-09-28

当前状态：Docker 安装及旧套接字阻塞已处理，WSL2 仍因固件虚拟化未启用而无法启动，系统也有待重启组件；镜像构建、容器启动和完整验收尚未执行，P10 仍未完成。

## 本次实测

- 原 Docker Desktop 4.91.0 位于用户目录，当前 PATH 找不到 docker。启动器与后端均因缺少安装注册信息而退出，并非完全没有安装程序。
- winget repair 没有可用修复入口，winget 下载停滞后已取消。改用官方同版本安装包，SHA256 为 `ac405b09942701770d581b173747fc1024cf0e6047cbe60f13d1df85437311ac`，与 winget 官方源清单一致。
- 覆盖安装至 `C:\Program Files\Docker\Docker`。首次安装中断，接续安装器自行处理前次中断状态，最终退出码为 0，管理员日志记录 `Installation succeeded`。
- 安装器明确报告启用 `Microsoft-Windows-Subsystem-Linux` 后需要重启；系统 `Component Based Servicing\RebootPending` 标记存在。
- 修复后的启动器已能启动后端。随后处理 `sailor-ingest.sock` 与 `docker-secrets-engine/engine.sock` 旧套接字无法访问问题：先退出启动失败的 Docker，再保留运行目录备份并重建。两目录仅包含运行套接字，没有移动镜像或业务数据。正常退出超时的一次重试仅结束标准安装目录内的 Docker 进程。
- 套接字问题处理后，后端已进入 WSL 发行版初始化，明确报 `HCS_E_HYPERV_NOT_INSTALLED` 和 `No virtualization available`。Win32_Processor 返回 AMD Ryzen 9 5950X、`VirtualizationFirmwareEnabled=False`、`VMMonitorModeExtensions=True`、`SecondLevelAddressTranslationExtensions=True`；Win32_ComputerSystem 返回 `HypervisorPresent=False`。
- 运行目录备份保留在 `%LOCALAPPDATA%\Docker\run-backup-20260928-1050`、`%LOCALAPPDATA%\Docker\run-backup-20260928-retry2`、`%LOCALAPPDATA%\docker-secrets-engine-backup-20260928-1050`。这些是套接字现场备份，不是业务库备份。
- Compose 静态配置解析通过；检查时 18787、18790、28787、28790 未发现监听占用，Chrome 存在。本机 Node 为 22.23.2，pnpm 为 11.23.0。
- 没有运行项目 build、创建项目容器、重置数据库、删除数据卷或恢复出厂设置。

安装日志：`C:\ProgramData\DockerDesktop\install-log-admin.txt`。
启动日志：`%LOCALAPPDATA%\Docker\log\host\Docker Desktop.exe.log` 与 `com.docker.backend.exe.log`。

## 重启后接续

先保存工作，在 BIOS/UEFI 中启用 AMD SVM 虚拟化并保存重启，再启动标准目录内的 Docker Desktop。固件菜单名称依主板而异。不要恢复 Docker 出厂设置或清空数据。回到 Windows 后先检查 `VirtualizationFirmwareEnabled` 和 `HypervisorPresent`；若仍不满足，再核查 Windows VirtualMachinePlatform 与 WSL 组件、系统重启状态和引导配置。

在 PowerShell 执行：

```powershell
Set-Location 'D:\project\agent-new\aftersales'
$env:Path = 'C:\Program Files\Docker\Docker\resources\bin;' + $env:Path
docker context inspect
docker --context desktop-linux info
docker compose version
```

确认 context 指向本机 npipe 或 unix，且服务端为 Linux。若仍出现套接字错误，继续检查最新后端日志，不直接删除 Docker 数据目录。

引擎可用后按[离线部署手册](../runbooks/offline-deployment.md)构建并验收：

```powershell
docker compose --env-file infra/docker/offline.env -p youju-p10 -f compose.yaml config --quiet
docker compose --env-file infra/docker/offline.env -p youju-p10 -f compose.yaml build
pnpm --config.verify-deps-before-run=false exec tsx scripts/p10-acceptance.ts
docker compose --env-file infra/docker/offline.env -p youju-p10 -f compose.yaml up -d --wait
Invoke-RestMethod http://127.0.0.1:18790/api/ready
docker compose --env-file infra/docker/offline.env -p youju-p10 -f compose.yaml ps
```

验收脚本使用独立项目和卷，检查两类退款、未知资金与费用保持、Linux 正常退出、备份恢复、无 Git 来源清单、HTTP L1 和浏览器 API/SSE。只有完整验收通过并核对证据后才能更新 P10 为完成。默认实例页面为 `http://127.0.0.1:18790/workbench`。
