/**
 * SQLite 表结构
 *
 * 单一初始化脚本 幂等建表
 * 关键不变量由数据库约束兜底
 *   run 内事件序号唯一
 *   退款单对售后单唯一 幂等键全局唯一
 *   售后单号 退款单号 审批号唯一
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone_masked TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  order_no TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  total_amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  payment_channel TEXT NOT NULL,
  items_json TEXT NOT NULL,
  paid_at TEXT,
  shipped_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

CREATE TABLE IF NOT EXISTS shipments (
  shipment_id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL,
  carrier TEXT NOT NULL,
  tracking_no TEXT NOT NULL,
  status TEXT NOT NULL,
  events_json TEXT NOT NULL,
  delivered_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments(order_no);

CREATE TABLE IF NOT EXISTS return_requests (
  return_no TEXT PRIMARY KEY,
  order_no TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  type TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  item_ids_json TEXT NOT NULL,
  refund_amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  policy_decision_json TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_returns_order ON return_requests(order_no);

CREATE TABLE IF NOT EXISTS refunds (
  refund_no TEXT PRIMARY KEY,
  return_no TEXT NOT NULL UNIQUE,
  order_no TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS approval_requests (
  approval_id TEXT PRIMARY KEY,
  run_id TEXT,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  one_time_token TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_resource ON approval_requests(resource_type, resource_id);

CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_version TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  description TEXT NOT NULL,
  time_window_days INTEGER,
  excluded_categories_json TEXT,
  UNIQUE(policy_version, rule_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  run_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_logs(run_id);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  intent TEXT,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  error TEXT,
  fault_plan_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON agent_runs(status);

CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, sequence)
);

CREATE TABLE IF NOT EXISTS tool_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  attempt INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  result_summary_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_executions_run ON tool_executions(run_id);

CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON checkpoints(run_id);

CREATE TABLE IF NOT EXISTS idempotency_records (
  key TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  resource_key TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_reports (
  report_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  total INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  gate_passed INTEGER NOT NULL,
  report_json TEXT NOT NULL
);
`
