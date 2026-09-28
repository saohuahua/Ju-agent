# P10 无 Git 评测入口修复

日期 2026-09-26

修复范围为镜像内缺少 Git 时正式离线评测入口返回 500 不修改原预算 身份 资金或评测判定规则 Docker 实际运行验收仍取决于可用环境

## 实现

Dockerfile 在安装锁定依赖后执行 scripts/p10-source-manifest.ts 从实际构建上下文生成 /app/.p10-source.json API 镜像通过 P9_SOURCE_MANIFEST 显式指定该清单 不复制宿主 .git 不安装 Git 不从未知来源补写提交号

清单记录现有受控范围的文件路径 每文件 SHA256 和整体内容哈希 head 与 dirty 为 null completeness 为 verified-deployment-content-manifest 明确表达镜像实际内容可核验 而原 Git 提交及工作树状态不可核实

运行时从磁盘重新枚举同一范围并逐项比对完整清单 不使用清单提供的路径读取其他文件 不仅验证自报 hash 清单缺失 JSON 损坏 文件变化 缺失 新增 重复 路径伪造 schema 版本或提交状态伪造均拒绝 不静默退回 Git

没有配置 P9_SOURCE_MANIFEST 时保持源码工作区的 Git HEAD dirty 和原受控内容清单模式 原报告字段均保留 只扩展部署来源中的 nullable 值 构建与源码工作区因裁剪而不同的内容哈希仍会导致公平比较拒绝 不将它们强行当相同源码实验

SourceIdentityError 在正式 HTTP 层映射到 503 SOURCE_IDENTITY_UNAVAILABLE 返回明确诊断但不暴露磁盘路径 缺失或损坏时还未调用模型和写入报告

该清单保证内容一致性 不是签名或外部可信供应链证明 镜像 API 仍以 node 用户运行 清单随根用户拥有的应用源码生成 不提供远程重建清单接口

## 验证

首次新增 HTTP 三项全部失败 日志 artifacts/p10-source-fix/red.log 原缺陷已确认不是仅 CLI 的问题

修复后 HTTP 定向 5/5 包括无 Git 的正式 L1 124/124 结果落库 339 次模拟费用调用 以及清单缺失损坏拒绝 原 L2 预算入口测试保持

清单与原 P9 定向 25/25 新增九项覆盖无 Git 清单识别及八种内容和元数据篡改 真实文件变化即使伪造或重算清单 hash 也拒绝 本轮新增测试共十二项 不与正式 L1 用例分母相加

生成器已在独立无 Git 临时目录实际执行 六个受控文件成功生成 head=null dirty=null 的清单 日志 artifacts/p10-source-fix/generator.log

最终全仓 692/692 退出码 0 全仓非增量类型 五个部署脚本严格类型 ESLint 和差异检查通过 日志在 artifacts/p10-source-fix/full-tests.log typecheck.log scripts-typecheck.log lint.log

增强本机验收通过 原始包 artifacts/p10/2026-09-26T10-47-51.176Z 仍为 local-main-process 恢复后正式 HTTP L1 报告 evr_f7ec3e62 为 124/124 gatePassed=true 原渠道计数不变 committed=4624 active=1 即保留原未知 1234 微元并增加 3390 模拟微元 没有把未知费用清零

正式 L1 的 124 个用例分母与全仓 692 条测试分别记录 无 Git HTTP 回归与本机正式进程是两个独立验证 不把两次 124 项合并为质量提升结论 所有大型原始证据留在 artifacts 不默认提交 JSON

实测命令 均带 pnpm --config.verify-deps-before-run=false

- --filter @aftersales/api exec vitest run test/p10-eval-source.test.ts test/eval-budget-entry.test.ts
- --filter @aftersales/eval exec vitest run test/p10-source-manifest.test.ts test/p9-quality.test.ts
- -r test
- -r exec tsc --noEmit --incremental false
- lint
- exec tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck --strict scripts/p10-acceptance.ts scripts/p10-source-manifest.ts scripts/p10-data.ts scripts/p10-browser.ts scripts/p10-build-web.ts
- exec tsx scripts/p10-acceptance.ts --local
- exec tsx scripts/p10-source-manifest.ts 独立无Git临时构建目录

## 部署验收补强

scripts/p10-acceptance.ts 现在在完成备份恢复后调用正式 POST /api/eval/run 要求 124/124 并读取持久费用附件核验 source 在 Docker 模式必须为部署清单来源 同时核对渠道不变 原 unknown active=1 保留 费用只增加该次 L1 的 3390 模拟微元

本轮未运行 Docker 镜像构建或容器 没有把本机测试称为容器验收 P10 尚不能全部收口 后续仍需在可用 Docker 环境运行增强后的原验收脚本 包括 Linux 原生模块 卷权限 SIGTERM 与浏览器 SSE

修改文件 packages/eval/src/p9-metadata.ts 与 index.ts apps/api/src/app.ts apps/api/test/p10-eval-source.test.ts packages/eval/test/p10-source-manifest.test.ts scripts/p10-source-manifest.ts scripts/p10-acceptance.ts infra/docker/Dockerfile .gitignore 及相关文档

未读取真实密钥 未访问真实模型或资金 未操作演示库或已有服务 未提交推送 P5 仍锁定
