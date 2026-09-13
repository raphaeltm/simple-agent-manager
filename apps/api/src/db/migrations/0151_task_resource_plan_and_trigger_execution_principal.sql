-- Additive persistence for versioned task resource intent/resolution plans.
ALTER TABLE tasks ADD COLUMN resource_requirement_plan_json TEXT;

-- Authorized trigger execution principal used by keep-active offboarding transfers.
ALTER TABLE triggers ADD COLUMN execution_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE triggers ADD COLUMN execution_user_authorized_at TEXT;
ALTER TABLE triggers ADD COLUMN execution_user_authorized_by TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_triggers_execution_user_id
  ON triggers(execution_user_id)
  WHERE execution_user_id IS NOT NULL;
