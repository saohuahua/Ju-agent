# P10 离线部署交接

后续来源清单修复 镜像内正式评测已适配无 Git 环境 不再依赖复制 .git 见 [修复交接](p10-source-manifest-fix.md) Docker 实际运行验收仍待可用环境 下文保留原交付记录

2026-09-26：配置与代码完成，本机恢复和生产构建通过，**容器运行验收受阻，P10 未全部完成**。原因是 Docker CLI 不可调用；不得把静态 YAML 或 Windows 进程通过写成容器运行通过。

默认入口为根 compose.yaml。旧 infra/docker/docker-compose.yml 保留为历史 PostgreSQL/Redis 可选设施，当前系统仍使用 SQLite，没有引入 Redis 队列或迁移数据库。

| 路径 | 实际职责 |
| --- | --- |
| 浏览器 127.0.0.1:18790 → Web 0.0.0.0:8790 | Next 生产构建与 start，同源 API 和 SSE |
| Web `/api` → api:8787 | 服务间转发，浏览器不解析容器 DNS |
| API 0.0.0.0:8787，宿主 127.0.0.1:18787 | 正式 main、持久会话和业务 Worker |
| API 进程 → 127.0.0.1 随机端口 | 原模拟器，独立 channel 卷，无宿主支付端口 |
| business 卷 | 业务、会话、事件、任务、执行权与 P7 费用 |
| channel 卷 | 原渠道 submissions、charges、故障与查询记录 |

首次全空库使用原夹具单事务播种；任意已有表数据阻止覆盖，包括订单数为零的任务/费用库。部分旧库不自动 reset；就绪检查失败时先备份核验。增量迁移仍用原 openDatabase/migrate，没有新迁移引擎。

SIGTERM 先停接入和 SSE，再等待原 Worker，最后关闭渠道和两库；15 秒超时失败退出，Compose 20 秒宽限。强退不清租约、资金未知或费用占位。Windows 本机强退已验证，Linux 信号收尾仍待容器实测。

## 修改清单

- Dockerfile、compose.yaml、.dockerignore、offline.env：Node/pnpm 固定、Linux 原生依赖、源码 workspace/tsx、生产 Web、双卷、回环端口、无环境文件和实验包
- API main/app/sse：组合原渠道、全空播种、存活/就绪、关闭监听及长连接和有界收尾
- persistence initialize-demo/db/index/payment-simulator：原子初始化、嵌套事务保存点、原渠道只读健康检查
- Web next.config.ts：部署构建专用同源 API/SSE rewrite，开发地址不变
- scripts/p10-acceptance.ts、p10-data.ts、p10-build-web.ts、p10-browser.ts：独立验收、计数、备份恢复、隔离生产构建及容器浏览器检查
- 初始化与健康 7 项回归；README、IMPLEMENTATION、交接入口和部署手册更新
- 根 packageManager、产物忽略和 ESLint 排除本地 artifacts

## 实测和限制

全仓 680/680、非增量类型、脚本类型、ESLint 及差异检查通过。定向 4/4 初始化、3/3 健康、22/22 既有相关恢复；正式离线 L1 另计 124/124。独立目录 Next 生产构建通过。完整证据、首次失败与修正、原 run/command/toolCall 关系见 [实测记录](../experiments/p10-offline-deployment.md)。

本机正式 main 新流程两笔成功渠道均 1/1，未知渠道 1/0；未知费用 1234 微元、active 1 在重启和恢复到新目录后保持；原工具结果与客户完成事件各一次。人工接管结构化寄回 409、普通留言 200、客户隔离 403。没有从预造审批或资金任务起步。

所有本轮服务使用独立端口/库，不占用或终止 8787/8790。未安装 Docker、启用虚拟化、修改防火墙或系统服务，未连接远端 Docker。镜像和容器仍未运行，卷权限、Linux 原生模块、Linux SIGTERM 及容器浏览器实测待补。容器内 P9 归档 CLI 也未验收，镜像不携带 Git 元数据；本轮正式 L1 在源码工作区执行。

## 接续方式

完整默认 build/up/health/logs/stop/down 保留数据及 WAL 一致备份、新卷恢复命令见 [操作手册](../runbooks/offline-deployment.md)。普通启动绝不 reset 或 down -v。验收脚本结束停止本轮服务，保留卷与 artifacts，可按日志中的 project 名继续检查。

下一步先获得可用本机 Docker 环境，执行默认构建及 `pnpm --config.verify-deps-before-run=false exec tsx scripts/p10-acceptance.ts`，处理真实构建或运行故障，核验正常退出日志和桌面/窄屏截图，再收口 P10。P11 完整学习交付随后另推进。

真实生产部署未做，演示令牌不是生产认证；真实模型质量未验证，Judge 未校准，P5 仍锁定。P6 仍只代表两类客户退款持久离线闭环，P8 未开启默认客户调查。本轮未提交或推送 Git。
