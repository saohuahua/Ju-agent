# P10 独立验收

日期 2026-09-26

后续更新 无 Git 正式评测入口已加入实际构建来源清单及 HTTP 回归 修复结果见 [来源清单修复](p10-source-manifest-fix.md) 下文保留原始缺陷记录 Docker 实测仍未完成

结论 本机部署与恢复链路复跑通过 但 P10 尚不能收口 Docker 容器实际验收仍受阻 另外确认一项镜像内正式评测入口的可用性缺陷 本轮未修改生产代码 未提交或推送

## P2 镜像缺少来源元数据导致正式评测入口失败

Dockerfile 不安装 Git dockerignore 白名单也不携带 .git 这本身是合理的镜像边界 但 packages/eval/src/p9-metadata.ts 的 sourceIdentity 无条件执行 git rev-parse HEAD 和 git status 失败直接抛出

这不只影响 P9 CLI apps/api/src/app.ts 863 行的 POST /api/eval/run 正式端点会调用 runBudgetedL1 后者首先构造 evaluationMetadata 因而同样依赖容器内 Git 仓库

独立复现使用内存业务库 原 createApp 和操作员 HTTP 入口 仅在探针进程将 GIT_DIR 指向不存在的目录 模拟缺少 Git 元数据 不改原仓库 结果为 HTTP 500 INTERNAL_ERROR p7_calls 数量为 0 错误发生在评测开始之前

该实验不是 Docker 实测 它证明缺少 Git 元数据会让正式入口失败 实际镜像不含 Git 元数据由构建上下文白名单直接确认 镜像是否还缺少其他运行依赖仍需实际构建验证

建议构建前生成受控的源码与版本来源清单 将可验证清单而非整个 .git 带入镜像 sourceIdentity 支持该只读清单并校验内容 缺失或不匹配要明确拒绝 不能伪造 clean HEAD 或删除 P9 可追溯要求

回归应覆盖无 Git 的部署目录通过正式 HTTP 执行离线 L1并保存可核验来源 清单损坏拒绝和源码工作区原模式兼容 如暂时不支持镜像内评测 应在 API 和网页明确禁用且说明能力边界 不能以泛化 500 代替

## 本轮独立复跑

- 全仓 pnpm --config.verify-deps-before-run=false -r test 680/680 退出码 0
- 全仓非增量类型检查与 ESLint 通过
- 四个 p10 脚本的独立严格类型检查通过
- pnpm --config.verify-deps-before-run=false exec tsx scripts/p10-acceptance.ts --local 通过
- git diff --check 通过

本轮本机原始包 artifacts/p10/2026-09-26T10-32-06.189Z 其摘要为 local-main-process passed

两筆成功模拟退款分别 submissions=1 charges=1 未知退款 submissions=1 charges=0 未知费用 committed=1234 active=1 重启与恢复后保留 验收脚本还检查原 toolCall 客户完成事件 人工寄回拒绝与越权 本次未用 HTTP 成功替代数据库和渠道断言

原始复跑日志在本地忽略目录 artifacts/p10-review 下的 full-tests.log typecheck.log scripts-typecheck.log lint.log local.log Git 缺失复现为 gitless-probe.ts gitless.log 和 gitless-result.json 大型数据不默认纳入 Git

本轮没有重新执行 Next 构建和 L1 数据集 交付方的隔离生产构建及 L1 124/124 属于已有证据 不混称本轮新结果 现有 Web 源码在全仓类型与 Web 测试范围内复核

## 未验证部分与下一步

当前 PATH 中仍未找到 Docker 命令 不等于断言系统从未安装 没有安装 Docker 改虚拟化 防火墙或系统服务

必须在可用本机 Linux Docker daemon 上完成镜像构建 Compose 启动 原生 SQLite 模块加载 node 用户卷写入 SIGTERM/SSE/Worker 收尾 容器重建 新卷恢复及浏览器同源 API/SSE 验收 才能判定 P10 完成

下一步顺序 先修复镜像内评测来源清单和正式入口 再落实 Docker 环境运行原验收脚本并处理实际失败 P10 通过后推进 P11 完整学习与面试交付 P5 继续锁定 真实模型与真实资金没有启用
