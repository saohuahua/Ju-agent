import type { SqliteDatabase } from './db.js'

/**
 * 专属增量迁移保留所有旧表和历史意图
 * 同库事务连接用于受理认领检查点与业务记账 独立渠道不得复用该连接
 */
export function migrateP6(db: SqliteDatabase): void {
  // 锁等待只缓解短暂写竞争 不代表多个写事务可以同时提交
  db.pragma('busy_timeout = 5000')
  // 命令按客户和请求键唯一 一个命令只关联一个任务
  // 检查点按任务和步骤唯一 资金效果按原业务键唯一
  // 会话退款关联保存原调用与授权 结果回填不从聊天文本猜测
  // 状态约束只限制合法取值 不替代服务层的合法迁移判断
  db.exec(`
    CREATE TABLE IF NOT EXISTS p6_commands (
      command_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      request_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
      input_json TEXT NOT NULL,
      UNIQUE(customer_id, request_key)
    );
    CREATE TABLE IF NOT EXISTS p6_tasks (
      task_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL UNIQUE REFERENCES p6_commands(command_id),
      run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
      customer_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      tool TEXT NOT NULL,
      approval_id TEXT UNIQUE REFERENCES approval_execution_intents(approval_id),
      status TEXT NOT NULL CHECK(status IN
        ('queued','running','completed','call_failed','business_failed','needs_confirmation','cancelled')),
      available_at INTEGER NOT NULL,
      owner TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      deadline INTEGER NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS p6_tasks_ready ON p6_tasks(status, available_at, lease_until);
    CREATE TABLE IF NOT EXISTS p6_steps (
      task_id TEXT NOT NULL REFERENCES p6_tasks(task_id),
      step TEXT NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY(task_id, step)
    );
    CREATE TABLE IF NOT EXISTS p6_effects (
      business_key TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      payment_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('prepared','sending','succeeded','rejected','unknown')),
      result_json TEXT,
      task_id TEXT NOT NULL REFERENCES p6_tasks(task_id)
    );
    CREATE TABLE IF NOT EXISTS p6_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES p6_tasks(task_id),
      event_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE(task_id, event_key)
    );
    CREATE TABLE IF NOT EXISTS p6_conversation_refunds (
      run_id TEXT PRIMARY KEY REFERENCES agent_runs(run_id),
      origin_task_id TEXT NOT NULL REFERENCES p6_tasks(task_id),
      step_key TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      return_no TEXT NOT NULL UNIQUE REFERENCES return_requests(return_no),
      approval_id TEXT UNIQUE REFERENCES approval_requests(approval_id),
      authorization_task_id TEXT REFERENCES p6_tasks(task_id),
      binding_json TEXT NOT NULL,
      projected INTEGER NOT NULL DEFAULT 0,
      UNIQUE(origin_task_id, tool_call_id)
    );
  `)
}
