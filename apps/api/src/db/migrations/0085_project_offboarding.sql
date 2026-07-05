CREATE TABLE IF NOT EXISTS project_ownership_transfers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  to_user_id TEXT NOT NULL,
  initiated_by TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_member_offboarding_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  member_user_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preview',
  resource_summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE TABLE IF NOT EXISTS project_member_offboarding_resource_actions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES project_member_offboarding_plans(id) ON DELETE CASCADE,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  credential_source_before TEXT NOT NULL,
  attribution_user_id_before TEXT,
  attribution_project_id_before TEXT,
  recommended_action TEXT NOT NULL,
  selected_action TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_offboarding_plans_project_member_status
  ON project_member_offboarding_plans(project_id, member_user_id, status);

CREATE INDEX IF NOT EXISTS idx_project_offboarding_actions_plan_kind
  ON project_member_offboarding_resource_actions(plan_id, resource_kind);

ALTER TABLE triggers ADD COLUMN credential_blocked_reason TEXT;
ALTER TABLE triggers ADD COLUMN credential_blocked_at TEXT;
ALTER TABLE triggers ADD COLUMN credential_blocked_by TEXT;

ALTER TABLE tasks ADD COLUMN credential_blocked_reason TEXT;
ALTER TABLE tasks ADD COLUMN credential_blocked_at TEXT;

ALTER TABLE nodes ADD COLUMN offboarding_status TEXT;
ALTER TABLE nodes ADD COLUMN offboarding_blocked_reason TEXT;
ALTER TABLE nodes ADD COLUMN offboarding_blocked_at TEXT;

ALTER TABLE deployment_environments ADD COLUMN offboarding_status TEXT;
