-- Additive only. Existing overrides and encrypted credentials remain authoritative.
CREATE TABLE admin_settings_revision (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  mutation_id TEXT NOT NULL DEFAULT ''
);
INSERT INTO admin_settings_revision(singleton) VALUES (1);
CREATE TABLE admin_settings_audit (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('set', 'reset')),
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL
);
CREATE INDEX idx_admin_settings_audit_revision ON admin_settings_audit(revision DESC);
