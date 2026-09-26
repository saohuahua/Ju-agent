# P8 验收缺陷修复交接

日期 2026-09-26

接续 P8 独立验收及中断的修复任务 保留原始失败记录和已有未提交成果 本轮只收口未知资金读取 同参重放和归档脚本规范问题

## 修复行为

P8 从客户订单对应的售后退款补偿价保资源推导业务幂等键 关联 p6_effects execution_ownership p6_tasks 原命令和运行客户 校验资源金额币种及持有者关联 保留业务表原状态 新增可选 execution 证据 不暴露发送令牌或审批凭据 审批关联同时验证资源类型和编号

真实 P6 未知退款仍保留 executing 效果 unknown 许可 sending 和任务 needs_confirmation P8 将其保留为 unknownActions 建议 human_review 且调查完整性为 false 关联异常同样不能归入已完成资金动作 已确认成功退款仍保留成功事实 查询不改变资金发送许可 不新增执行或重试

在原 immediate 受理事务中先验证模拟快照与基本身份 再按客户及实验身份查找原任务 同参重放直接返回原身份 acceptedAt 仅作为受理时间元数据不参与冲突判定 其余输入必须与原冻结输入一致 同键异参明确拒绝 只有新请求才校验当前源事实 不新建任务或重算原证据

四份网页归档脚本仅增加其需要的 document innerWidth fetch 只读环境声明 不关闭 ESLint 规则

## 修改清单

- packages/contracts/src/p8-investigation.ts 新增可选资金证据
- packages/persistence/src/p8-business-references.ts 只读资金关联与校验
- packages/persistence/src/p8-investigation-repository.ts 不确定动作投影与同参重放
- packages/runtime/src/p8-investigation.ts 复用关联读取并提前处理重放
- packages/runtime/test/p8-fixes.test.ts 新增七项真实链路及重放回归
- packages/runtime/test/p8-investigation.test.ts 修正审批夹具类型 同时覆盖同键冲突及新请求源事实校验
- eslint.config.js 限定四份归档脚本的环境声明
- 本交接 实验记录 原验收报告 共享交接入口和 IMPLEMENTATION 状态更新

## 验证与范围

命令 结果 首次失败和修复后原始探针见 [实验证据](../experiments/p8-fixes.md)

最终全仓 640/640 P8 定向 34/34 全仓非增量类型和 ESLint 通过 正式离线 L1 另计 124/124 四组对照通过 本次已关闭原验收报告中的两项缺陷和归档规范问题

新增七项覆盖真实未知退款 正常成功退款 legacy 未知许可 任务归属篡改 以及 queued 单分支已完成 全部完成三个阶段的源变化重放 原测试继续覆盖真实子进程恢复 客户越权和证据伪造

运行记忆仍是受理时冻结的业务事实 不持续追踪受理后的资金变化 不将 P8 接入正式客户默认路由 本次结论仅限 P8 有限双分支调查及运行记忆的离线机制 真实模型质量和生产性能未验证 P5 保持锁定

未 build 未读取环境文件或真实密钥 未操作演示数据库或既有 8787 8790 服务 未调用真实模型或真实资金 未提交 Git 本次没有重新执行网页浏览器交互验收
