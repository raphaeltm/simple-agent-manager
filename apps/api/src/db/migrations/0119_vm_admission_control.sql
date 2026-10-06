-- VM admission control and fenced provisioning backpressure.
-- Additive-only migration: no table rebuilds, drops, or destructive data movement.

ALTER TABLE tasks ADD COLUMN admission_state TEXT;
ALTER TABLE tasks ADD COLUMN admission_reason TEXT;
ALTER TABLE tasks ADD COLUMN admission_next_retry_at TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_admission_state
  ON tasks(admission_state)
  WHERE admission_state IS NOT NULL;

CREATE TABLE IF NOT EXISTS vm_task_admissions (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  credential_domain_key TEXT NOT NULL,
  provider_domain_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  requested_vm_size TEXT NOT NULL,
  requested_vm_location TEXT NOT NULL,
  preferred_node_id TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  reason TEXT,
  selected_node_id TEXT,
  inflight_node_id TEXT,
  fencing_token INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  wait_deadline_at TEXT,
  provider_category TEXT,
  provider_code TEXT,
  provider_status_code INTEGER,
  provider_message TEXT,
  enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at TEXT,
  last_evaluated_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vm_task_admissions_user_state_retry
  ON vm_task_admissions(user_id, state, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_vm_task_admissions_scope_state_retry
  ON vm_task_admissions(scope_key, state, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_vm_task_admissions_provider_domain_state_retry
  ON vm_task_admissions(provider_domain_key, state, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_vm_task_admissions_inflight_node
  ON vm_task_admissions(inflight_node_id)
  WHERE inflight_node_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS vm_provisioning_leases (
  scope_key TEXT PRIMARY KEY,
  owner_task_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL,
  credential_domain_key TEXT NOT NULL,
  provider_domain_key TEXT NOT NULL,
  requested_vm_size TEXT NOT NULL,
  inflight_node_id TEXT,
  acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  heartbeat_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vm_provisioning_leases_owner
  ON vm_provisioning_leases(owner_task_id);

CREATE INDEX IF NOT EXISTS idx_vm_provisioning_leases_expires
  ON vm_provisioning_leases(expires_at);

CREATE INDEX IF NOT EXISTS idx_vm_provisioning_leases_inflight_node
  ON vm_provisioning_leases(inflight_node_id)
  WHERE inflight_node_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS vm_provider_capacity_state (
  provider_domain_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  credential_domain_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ok',
  reason TEXT,
  provider_category TEXT,
  provider_code TEXT,
  provider_status_code INTEGER,
  provider_message TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  last_failure_at TEXT,
  last_success_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vm_provider_capacity_state_retry
  ON vm_provider_capacity_state(state, retry_at);
