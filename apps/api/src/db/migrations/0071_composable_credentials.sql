-- Composable Credentials: three-primitive model
-- Additive migration only — NO table drops (Rule 31)
-- The old `credentials` and `platform_credentials` tables remain untouched.
-- New tables store the decomposed model: Credential + Configuration + Attachment.

-- Primitive 1: Credential (agent-agnostic, named, typed secret)
CREATE TABLE IF NOT EXISTS cc_credentials (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,  -- 'api-key' | 'oauth-token' | 'openai-compatible' | 'cloud-provider' | 'auth-json'
  encrypted_token TEXT NOT NULL,
  iv TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cc_credentials_owner ON cc_credentials(owner_id);
CREATE INDEX IF NOT EXISTS idx_cc_credentials_owner_kind ON cc_credentials(owner_id, kind);

-- Primitive 2: Configuration (consumer + credential ref + settings)
CREATE TABLE IF NOT EXISTS cc_configurations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  consumer_kind TEXT NOT NULL,    -- 'agent' | 'compute'
  consumer_target TEXT NOT NULL,  -- 'claude-code' | 'hetzner' etc.
  credential_id TEXT REFERENCES cc_credentials(id) ON DELETE SET NULL,
  settings_json TEXT,             -- JSON blob for model, baseUrl, etc.
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cc_configurations_owner ON cc_configurations(owner_id);
CREATE INDEX IF NOT EXISTS idx_cc_configurations_credential ON cc_configurations(credential_id);

-- Primitive 3: Attachment (binds a configuration into a scope)
CREATE TABLE IF NOT EXISTS cc_attachments (
  id TEXT PRIMARY KEY,
  configuration_id TEXT NOT NULL REFERENCES cc_configurations(id) ON DELETE CASCADE,
  consumer_kind TEXT NOT NULL,    -- denormalized for fast lookup
  consumer_target TEXT NOT NULL,  -- denormalized for fast lookup
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- null = user-default
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cc_attachments_user ON cc_attachments(user_id);
CREATE INDEX IF NOT EXISTS idx_cc_attachments_user_consumer ON cc_attachments(user_id, consumer_kind, consumer_target);
CREATE INDEX IF NOT EXISTS idx_cc_attachments_project ON cc_attachments(user_id, project_id, consumer_kind, consumer_target);
CREATE INDEX IF NOT EXISTS idx_cc_attachments_config ON cc_attachments(configuration_id);
