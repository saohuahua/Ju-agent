# 本地与容器一致性

本地离线入口默认使用与根目录 `compose.yaml` 相同的 `simulation` 业务模式和内嵌模拟支付渠道。真实模型对话可从本机设置页经过连接测试后单独启用，真实支付始终不启用；具体步骤见[模型设置](model-settings.md)。两种运行方式的数据相互独立。

## 启动

先确认已安装依赖。建议使用与 Docker 相同的 Node 22.23.2 和 pnpm 11.23.0。在仓库根目录运行：

```powershell
pnpm dev:offline
```

首次配置真实模型时，在项目根目录的 `.env` 填写 `MODEL_PROTOCOL`、对应协议的 `*_BASE_URL`、`*_MODEL`、`*_API_KEY` 以及 `MODEL_INPUT_CNY_PER_MILLION` 和 `MODEL_OUTPUT_CNY_PER_MILLION`。启动器读取该文件，主管设置页会预填非密钥字段并识别已配置的 Key。每次启动仍需在本机设置页完成连接测试和“保存并启用”，模型管理口令可通过 `.env` 中的 `MODEL_LOCAL_TOKEN` 固定。启动和配置预填不会自动调用供应商；连接测试和启用后新建的真实模型会话可能产生费用。

启动器同时运行 API 和 Next 开发服务器，等到 API `/api/ready` 与 Web 代理 `/api/health` 返回持久退款模拟模式后打印工作台地址。浏览器打开终端打印的地址。停止时在同一终端按 Ctrl+C。API 源码变化后重新启动命令，Web 页面由 Next 开发服务器更新。

此命令优先使用 127.0.0.1:8787 和 127.0.0.1:8790；端口已被占用时会自动选空闲端口，并打印实际工作台地址，不会结束原进程。业务库为 `data/local-offline/business/app.db`，渠道库为 `data/local-offline/channel/channel.db`。重启会保留两库，不运行 `db:reset`。首次打开空库时使用项目已有夹具初始化；已有库不会自动补写缺失夹具。

空库启动会创建当前代码所需的业务表、P8 调查关联表和模拟渠道表，并播种基础客户、订单与政策。它生成新的演示数据，不会找回旧电脑上的会话、审批、退款、事件或渠道记录。需要保留这些记录时使用下面的双库备份。

## 换电脑保留数据

先在运行窗口按 Ctrl+C 停止本地离线服务，然后在仓库根目录运行：

```powershell
pnpm data:backup:offline
```

命令会检查两库完整性，并在 `artifacts/offline-backups/` 下创建带时间的备份目录，打印绝对路径。目录中有 `business.db`、`channel.db` 和 `manifest.json`。这三份文件必须一起带走；`artifacts/` 被 Git 忽略，不会随源码提交或拉取。备份中包含现有表结构和全部数据，SQLite 文件可以在不同操作系统上读取，无需另外执行建表 SQL。

也可以把空的外接目录直接作为参数，例如 `pnpm data:backup:offline 'E:\backups\aftersales'`。目标目录必须为空，命令不会覆盖已有备份。

在新电脑安装项目依赖后、首次启动服务前，把整个备份目录放到任意位置，再运行：

```powershell
pnpm data:restore:offline 'D:\backups\aftersales-2026-09-28'
pnpm dev:offline
```

把示例路径换成实际备份目录。恢复会先核对两个文件的 SHA256，再复制到空的本地双库目录，并检查两库完整性。目标业务目录或渠道目录已有文件时拒绝覆盖，因此如果新电脑已经启动过项目，应先保留现有数据，选择一个未初始化的工作目录恢复；不要直接删除或重置有业务记录的库。备份时不能运行 `pnpm dev:offline`，启动器会阻止本地备份命令读取运行中的双库。

项目代码和锁文件也要一起迁移或在新电脑重新拉取同一版本。数据库备份不包含 `node_modules`、Next 构建产物和真实模型密钥。恢复旧版本数据库后，首次启动会执行当前代码的增量迁移；数据库格式的跨版本兼容仍应按实际目标版本验证。

## 核验

```powershell
$workbench = Read-Host '输入启动器打印的工作台地址'
$origin = ([uri]$workbench).GetLeftPart([System.UriPartial]::Authority)
Invoke-RestMethod "$origin/api/ready"
Invoke-RestMethod "$origin/api/health"
```

`ready` 应为 `ready`，`health.conversationMode` 应为 `durable_refund_simulation`。上述探针只检查就绪，不证明退款或恢复流程正确。完整本地核心流程可用现有独立临时库验收，不写日常开发库：

```powershell
pnpm --config.verify-deps-before-run=false exec tsx scripts/p10-acceptance.ts --local
```

Docker 镜像构建完成且引擎可用后，用[离线部署手册](offline-deployment.md)中的容器验收命令验证 Linux、生产构建、双卷和重启恢复。当前机器的容器验收仍待完成，不能把本地通过视为 Docker 已通过。

## 一致范围

| 项目            | 本地离线入口                          | Docker 入口                         |
| --------------- | ------------------------------------- | ----------------------------------- |
| 业务模式与渠道  | simulation 与内嵌模拟渠道             | 相同                                |
| 浏览器 API 路径 | 同源 `/api` 代理到本次启动的 API 端口 | 同源 `/api` 代理到容器 `api:8787`   |
| 数据            | 本地两份 SQLite 文件                  | 两个独立 named volume               |
| Web 运行        | Next 开发服务器                       | 预构建的 Next 生产服务器            |
| API 运行        | Windows Node 与本地原生模块           | Linux Node 22.23.2 与镜像内原生模块 |
| 更新代码        | 重启本地入口                          | 重建镜像                            |

这保证配置层面的业务模式一致，不保证操作系统、Node 小版本、构建产物和生命周期行为天然一致。实际运行的 Node 版本以启动器打印的版本为准；本机通过 pnpm 启动时使用 22.19.0，而镜像固定 22.23.2。涉及原生模块、代理、进程退出或恢复的改动，需要继续运行对应容器验收。两边不能同时写同一个 SQLite 文件；需要迁移数据时按[离线部署手册](offline-deployment.md)停写并成对备份业务库与渠道库。
