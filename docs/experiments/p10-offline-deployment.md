# P10 离线部署实测

后续修复 无 Git 正式评测入口已接入可校验构建来源清单 最终全仓 692/692 类型 ESLint 与增强本机验收通过 恢复后 HTTP L1 另计 124/124 见 [修复交接与实测](../handoffs/p10-source-manifest-fix.md) 下文为原交付记录 Docker 容器验收仍受阻

日期 2026-09-26。起点 `feat/youju-aftersales-upgrade` / `4c3939911a6bdd66fc7c7b0f6a7727b462708d8e`，开始工作树干净。未提交、推送或操作 origin 原项目。

## 结论分层

| 项目 | 结论 |
| --- | --- |
| 配置和脚本 | 已完成 Dockerfile、默认 Compose、上下文白名单、生命周期、初始化及验收脚本 |
| 本机正式入口 | 独立 main.ts 进程退款、强退、重启、备份恢复通过 |
| 前端生产构建 | 独立无环境文件目录构建通过，非 dev server 验收 |
| 容器运行 | **受阻**，Docker CLI 不可调用，未验证 daemon、Compose CLI 配置、Linux 镜像构建、卷权限和容器浏览器 |
| 真实生产部署 | 未做，只有演示令牌 |
| 真实模型质量 | 未验证，Judge 未校准，P5 仍锁定，P11 未开始 |

## 环境事实

PATH 未找到 docker；`C:/Program Files/Docker/Docker/resources/bin/docker.exe` 和用户 `AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe` 均不存在。Docker 用户目录仍存在，安装日志记录 2026-09-09 卸载，故不能写为从未安装。未发现 Docker 服务或进程；Win32_Process 详细读取被系统拒绝，未改系统设置。命名管道检查没有找到可用 docker 管道。这些检查不足以代替 `docker info`。

实际执行 `docker compose version`、`docker info`、`docker compose -f compose.yaml config --quiet` 均报 command not found。Docker 验收脚本也在只读 context 检查时报 `spawnSync docker ENOENT`，没有创建容器或操作远端。见 [阻塞日志](p10-evidence/docker-blocked.log)。

直接 shell Node 为 v22.23.2；pnpm 11.23.0 实际运行脚本使用 Volta Node v22.19.0，见本机原始 process.log 的可执行路径。镜像声明固定 v22.23.2，尚未运行 Linux 构建，不能把 Windows Node/原生库通过当成镜像验证。

## 实测命令与结果

所有 pnpm 命令带 `--config.verify-deps-before-run=false`，避免既有工作区运行时重装依赖。

| 命令 | 实测 |
| --- | --- |
| `pnpm --filter @aftersales/persistence exec vitest run test/p10-initialize.test.ts` | 4/4 首次、重复、部分数据、播种失败回滚 |
| `pnpm --filter @aftersales/api exec vitest run test/p10-health.test.ts` | 3/3 存活与就绪分离、探针不写资金、SSE 停止 |
| `pnpm --filter @aftersales/api exec vitest run test/conversation-refund-process.test.ts test/customer-progress.test.ts test/p7-entry-closure-process.test.ts test/sse.test.ts` | 22/22 包括六个原故障边界和 live 写库前拒绝 |
| `pnpm exec tsx scripts/p10-acceptance.ts --local` | 最终完整场景通过，见下表及原始摘要 |
| `pnpm exec tsx scripts/p10-build-web.ts` | Next 15.5.25 生产构建成功，13 页生成完成；只有既有 Next ESLint 插件提示 |
| `pnpm test` | 全仓 680/680，新增 7 项已包含，不与定向次数相加 |
| `pnpm -r exec tsc --noEmit --incremental false` | 全仓通过 |
| `pnpm exec tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck --strict scripts/p10-acceptance.ts scripts/p10-browser.ts scripts/p10-data.ts scripts/p10-build-web.ts` | 新脚本类型通过 |
| `pnpm lint`、`git diff --check` | 通过 |
| `pnpm eval --offline --repeat 1 --db artifacts/p10-l1/application.db --output artifacts/p10-l1/reports --experiment-id p10-fixture-regression` | 正式 L1 另计 124/124，evr_fd50e59c，3390 模拟微元，无未知费用 |

L1 因共享夹具事务边界变化做一次补充复验，未修改评测算法或模型预算算法，不机械复跑全部历史 P9 实验。原 P9 unknown 判定保持。

证据：[全仓](p10-evidence/full-test.log)、[定向](p10-evidence/targeted.log)、[健康](p10-evidence/health.log)、[构建](p10-evidence/build-first.log)、[L1](p10-evidence/l1.log)、[本机最终](p10-evidence/local-final.log)、[ESLint](p10-evidence/lint-final.log)、[全仓类型](p10-evidence/typecheck.log)、[脚本类型](p10-evidence/scripts-typecheck.log)、[精简事实](p10-evidence/summary.json)、[静态解析与构建路由](p10-evidence/static.json)。

追加保持非终态 SSE 连接后停止的整轮本机复验也通过，见 [追加日志](p10-evidence/local-final-sse.log)，原始包为 `artifacts/p10/2026-09-26T10-23-55.578Z`。这仍不等于 Linux SIGTERM 通过；Docker 脚本另外要求正常 stop 后退出码为零并出现数据库关闭日志。

## 正式入口和数据证据

最终原始摘要在 `artifacts/p10/2026-09-26T10-10-02.064Z/summary.json`，SHA256 `a4c2982647f99176adc5eac70214ceb2c8618901a760109726539e716c31092d`。独立库目录为 `C:/Users/htlocal/AppData/Local/Temp/youju-p10-k5evcM`。完整 JSON、两库备份及 process.log 只留本地忽略目录，源码保留本精简记录。

| 客户入口事实 | 验证结果 |
| --- | --- |
| 仅退款 `run_c5222aa6-fc5a-41ab-9110-372dd48bce56` | RT-2026-0002，重放返回同一 run/command/task，最终 submissions 1 charges 1 |
| 退货 `run_f7e15bc4-3df2-4007-978d-ddf72f8ae722` | RT-2026-0003，待寄回阶段强退并重新启动 main，原关联保留；寄回重放后收货前该渠道记录为零，收货后 1/1 |
| 人工 `run_8978cf16-e51d-4d24-85c5-ae14984f2255` | 从客户补偿诉求升级，经正式接管；结构化寄回 409，普通留言 200，其他客户进度查询 403 |
| 未知资金 `run_0299fbbb-83bb-493f-9721-2785c94020e0` | RT-2026-0004，原渠道故障 unknown，submissions 1 charges 0，重启与恢复仍 unknown |
| 未知费用 | 原 P7Ledger reserve/finish 产生 CANCELLED/unknown 的独立探针，保留 1234 微元和 active 1；不是伪造客户审批或资金任务 |

两个成功退款均核对原 p6_conversation_refunds、refunds、execution_ownership、精确原 toolCall 的 agent.tool_results 和客户 run.completed；成功工具结果与完成事件均各一次。不是只检查 HTTP 200。原渠道不包含基线历史退款 RT-2026-0001，该记录属于夹具历史，不计为本轮成功动作。

费用共 11 行，其中 10 行离线会话零价结算、1 行未知预留。重启前后 calls 完全一致；恢复新目录后对 orders、runs、tasks、links、refunds、ownership、events、calls、totals、channel 整体快照做深比较。两库 integrity_check 通过；未知资金没有重新获权，渠道计数没有增加。

备份采用停写加 SQLite backup，恢复到两个新的空目录。业务备份 SHA256 `8ab2a2879e74a35cad11e5e4151f23f178d90a1ce754aebf804e8af212d34df4`；渠道备份 `0059e104f92823380b50ba3a3b4c62d48ea732a1978a85bb6e64621f94774409`。这证明本机文件恢复，不是 Docker 新卷恢复。

六个既有实际子进程故障矩阵复跑全过，包含支付响应已到但本地未落账的 exit 73 场景，查询原渠道恢复后每场景仍 submissions 1 charges 1。证据由原测试写在本轮时间戳 `docs/experiments/p6-conversation-refund-evidence/process-*`，未重用旧结果冒充本轮结果。

## 首次失败与修正

首次写日志遇到沙箱文件权限问题，经过受审授权在既定仓库写入，不改变系统权限。第一次本机脚本运行选择其他客户订单造成等待超时；仅修正独立验收基础订单归属。第二次试图从 awaiting_input 直接接管，正式接口如实返回 409；改为真实客户请求触发 escalated 再走接管。未删除断言，未强改 run 状态，失败分别见 local-first.log、local-second.log。

第三轮主业务通过后补入真实停写备份、空目录恢复和 live 拒绝，最终整轮再次通过。格式/规范检查修正了一处脚本条件表达式写法。没有修改支付状态或租约来满足测试。

## 静态结果与未执行边界

现有 js-yaml 解析默认 Compose 成功，确认两个服务、两个卷及所有宿主端口均回环；这是 YAML 检查，**不是 Docker Compose config 通过**。隔离构建的 routes-manifest 确认 `/api/:path* → http://api:8787/api/:path*`，不证明容器 SSE 代理实测。

未执行成功：Docker 镜像构建、Compose up、Linux better-sqlite3 加载、node 用户卷写权限、容器重建/新卷恢复、Linux SIGTERM 下长连接和 Worker 有界退出、生产页面对真实容器 API/SSE 的浏览器测试。Windows 进程 kill 不能冒充 POSIX SIGTERM。没有用本机 dev server 或静态 Mock 页面代替这些证据。

后续条件：本机 Docker CLI、Compose v2、Linux daemon 可用，18787/18790 与验收 28787/28790 空闲，构建依赖可获取，本机 Chrome/Chromium 可用。按 [操作手册](../runbooks/offline-deployment.md) build 后运行 `pnpm exec tsx scripts/p10-acceptance.ts`，审查 Linux 正常退出日志与浏览器截图。P10 容器验收收口后再推进 P11。
