-- PostgreSQL 生产路径 DDL
-- 与 SQLite 实现保持同语义约束 唯一键 事务 条件更新
-- 仓储接口不变 只需提供 PostgreSQL 实现即可切换

CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone_masked TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  order_no TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  status TEXT NOT NULL,
  total_amount_cents BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  payment_channel TEXT NOT NULL,
  items_json JSONB NOT NULL,
  paid_at TIMESTAMPTZ,
  shipped_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

CREATE TABLE IF NOT EXISTS shipments (
  shipment_id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL,
  carrier TEXT NOT NULL,
  tracking_no TEXT NOT NULL,
  status TEXT NOT NULL,
  events_json JSONB NOT NULL,
  delivered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments(order_no);

CREATE TABLE IF NOT EXISTS return_requests (
  return_no TEXT PRIMARY KEY,
  order_no TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  type TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  item_ids_json JSONB NOT NULL,
  refund_amount_cents BIGINT NOT NULL,
  currency TEXT NOT NULL,
  policy_decision_json JSONB NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_returns_order ON return_requests(order_no);

CREATE TABLE IF NOT EXISTS refunds (
  refund_no TEXT PRIMARY KEY,
  return_no TEXT NOT NULL UNIQUE,
  order_no TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  currency TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS approval_requests (
  approval_id TEXT PRIMARY KEY,
  run_id TEXT,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  status TEXT NOT NULL,
  one_time_token TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_resource ON approval_requests(resource_type, resource_id);

CREATE TABLE IF NOT EXISTS policies (
  id BIGSERIAL PRIMARY KEY,
  policy_version TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  description TEXT NOT NULL,
  time_window_days INT,
  excluded_categories_json JSONB,
  UNIQUE(policy_version, rule_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  actor_role TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  detail_json JSONB NOT NULL,
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
  fault_plan_json JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON agent_runs(status);

CREATE TABLE IF NOT EXISTS agent_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(run_id, sequence)
);

CREATE TABLE IF NOT EXISTS tool_executions (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT,
  tool_name TEXT NOT NULL,
  args_json JSONB NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  attempt INT NOT NULL,
  latency_ms INT NOT NULL,
  result_summary_json JSONB,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_executions_run ON tool_executions(run_id);

CREATE TABLE IF NOT EXISTS checkpoints (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  state_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON checkpoints(run_id);

CREATE TABLE IF NOT EXISTS idempotency_records (
  key TEXT PRIMARY KEY,
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  resource_key TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_reports (
  report_id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  total INT NOT NULL,
  passed INT NOT NULL,
  failed INT NOT NULL,
  gate_passed BOOLEAN NOT NULL,
  report_json JSONB NOT NULL
);
