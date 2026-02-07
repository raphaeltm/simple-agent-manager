-- UI Governance foundation for shared design system operations
-- Migration: 0004_ui_governance.sql

CREATE TABLE IF NOT EXISTS ui_standards (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  name TEXT NOT NULL,
  visual_direction TEXT NOT NULL,
  mobile_first_rules_ref TEXT NOT NULL,
  accessibility_rules_ref TEXT NOT NULL,
  owner_role TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS theme_tokens (
  id TEXT PRIMARY KEY,
  standard_id TEXT NOT NULL REFERENCES ui_standards(id) ON DELETE CASCADE,
  token_namespace TEXT NOT NULL,
  token_name TEXT NOT NULL,
  token_value TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'default',
  is_deprecated INTEGER NOT NULL DEFAULT 0,
  replacement_token TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS component_definitions (
  id TEXT PRIMARY KEY,
  standard_id TEXT NOT NULL REFERENCES ui_standards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  supported_surfaces_json TEXT NOT NULL,
  required_states_json TEXT NOT NULL,
  usage_guidance TEXT NOT NULL,
  accessibility_notes TEXT NOT NULL,
  mobile_behavior TEXT NOT NULL,
  desktop_behavior TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_checklists (
  id TEXT PRIMARY KEY,
  standard_id TEXT NOT NULL REFERENCES ui_standards(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  items_json TEXT NOT NULL,
  applies_to_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_instruction_sets (
  id TEXT PRIMARY KEY,
  standard_id TEXT NOT NULL REFERENCES ui_standards(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  instruction_blocks_json TEXT NOT NULL,
  examples_ref TEXT,
  required_checklist_version TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS exception_requests (
  id TEXT PRIMARY KEY,
  standard_id TEXT NOT NULL REFERENCES ui_standards(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  rationale TEXT NOT NULL,
  scope TEXT NOT NULL,
  expiration_date TEXT NOT NULL,
  approver TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_runs (
  id TEXT PRIMARY KEY,
  standard_id TEXT NOT NULL REFERENCES ui_standards(id) ON DELETE CASCADE,
  checklist_version TEXT NOT NULL,
  author_type TEXT NOT NULL,
  change_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  findings_json TEXT,
  reviewed_by TEXT,
  exception_request_id TEXT REFERENCES exception_requests(id) ON DELETE SET NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS migration_work_items (
  id TEXT PRIMARY KEY,
  standard_id TEXT NOT NULL REFERENCES ui_standards(id) ON DELETE CASCADE,
  surface TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT NOT NULL,
  due_milestone TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ui_standards_status ON ui_standards(status);
CREATE INDEX IF NOT EXISTS idx_theme_tokens_standard_id ON theme_tokens(standard_id);
CREATE INDEX IF NOT EXISTS idx_component_defs_standard_id ON component_definitions(standard_id);
CREATE INDEX IF NOT EXISTS idx_checklists_standard_id ON compliance_checklists(standard_id);
CREATE INDEX IF NOT EXISTS idx_instruction_sets_standard_id ON agent_instruction_sets(standard_id);
CREATE INDEX IF NOT EXISTS idx_exception_requests_standard_id ON exception_requests(standard_id);
CREATE INDEX IF NOT EXISTS idx_compliance_runs_standard_id ON compliance_runs(standard_id);
CREATE INDEX IF NOT EXISTS idx_migration_items_standard_id ON migration_work_items(standard_id);
