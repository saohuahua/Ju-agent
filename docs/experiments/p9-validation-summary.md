# P9 提交验收摘要

最终代码全仓 673/673 类型 ESLint 与差异检查通过 正常离线 L1 两轮 248/248 受控故障 124/248 如实失败 新增失败 124 未知费用保留 实际总费用差值为 null

完整 JSON 逐用例包和报告附件保留本地 不随源码提交 下表保存关键原始包哈希 需要复核时可在本机使用 p9-cli verify 或重新运行离线实验

| 本地原始文件 | SHA256 |
| --- | --- |
| `docs/experiments/p9-fix-evidence/normal-final/evr_18c196b2/quality.json` | `7826011778b405a524af9c1364024218a2183242e02fbd5f0ec21f8988d93028` |
| `docs/experiments/p9-fix-evidence/fault-final/evr_c61da38b/quality.json` | `948feadf504a44da0f53157e906b3805f9d5e27d3349e8badd68a958fc2b5f55` |
| `docs/experiments/p9-fix-evidence/comparison/comparison.json` | `0cca108cd284070d58ed15b410776c85ba1d7b65375e517ce4c2ec5f79243308` |
| `docs/experiments/p9-offline-quality-evidence/fault-final/evr_59e4c579/quality.json` | `0d7f8792246b6b030a73244fe57c14092804b5593cf33a9873112a6411fe928d` |

保留各轮原始失败日志和最终检查日志 不把历史实验分母与最终结果相加

本次删除 46 个未跟踪重复实验目录 约 338 MB 包括旧阶段重复进程输出与已被最终版本替代的 P9 中间包 未删除已跟踪文件 最终进程证据及正式验收包仍保留本地

提交按 Judge 修复 离线评测闭环 多轮网页展示 文档归档四个功能组织 未 build 未调用真实模型或真实资金 P5 仍锁定 下一步 P10 离线部署
