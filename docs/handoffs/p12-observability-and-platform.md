# P12 可观测回流与平台加固交接

日期：2026-09-29

## 交付范围

按[实施计划](../plans/2026-09-29-P12-可观测回流与平台加固计划.md)完成四项，未接入外部 collector、未做分布式限流、未自动入库评测用例。

1. OTel GenAI 导出 `packages/telemetry` 与 `pnpm trace:export`
2. 会话转 L1 草稿 `pnpm case:from-run` / `pnpm case:adopt`，分类 `regression`
3. 单进程内存限流、POST 请求超时、SSE 连接上限与最长存活
4. 客户空闲会话 TTL 收尾 `cancelled` + `run.expired`

## 阶段 0 核实结论

- 事件 `created_at` 为 `Date.toISOString()` 毫秒精度 时长仍优先用 `latencyMs` 与账本时间
- 消息端点持久路径 202 旧路径后台执行 请求超时按 POST 30 秒评测 600 秒 SSE 不走该中间件
- 回流用例从 `import.meta.url` 解析 `eval/cases/regression`
- 草稿 fixture 固定 baseline 人工核对夹具
- SSE 到期只发 `: server-refresh` 不发 `stream.complete` 浏览器可带 Last-Event-ID 重连
- `cancelled` 已在评分终态与运营状态序中 本轮不改口径

## 复现

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm eval
pnpm trace:export -- --run <runId> --db data/local-offline/business/app.db
pnpm case:from-run -- --run <runId>
```

限流与超时在 `VITEST` 下默认关闭 专项测试显式打开。生产默认开启。

空闲 TTL 默认 72 小时 扫描默认 10 分钟 可用 `SESSION_IDLE_TTL_HOURS` `SESSION_IDLE_SCAN_MS` 覆盖。

## 边界

- 导出不表示已接入 Langfuse 或任何 collector
- 草稿重放依赖脚本轨迹与 baseline 夹具 真实模型会话通常需要改断言后才能作为回归
- 限流是进程内固定窗口 多实例不共享计数
- 系统过期与客户 `end_consultation` 分离 后者仍是 `completed`
- 在途 p6 任务与退款关联的会话不会被 TTL 收尾
