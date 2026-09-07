-- Credential-limit observation state for edge-triggered project events.
-- Raw provider streams are not stored here; one bounded row is retained per
-- project/credential/window so ProjectData only receives warning/critical/
-- rejected/reset transitions.

ALTER TABLE agent_sessions ADD COLUMN agent_credential_source TEXT DEFAULT 'user' CHECK (agent_credential_source IN ('user', 'project', 'platform'));
ALTER TABLE agent_sessions ADD COLUMN agent_credential_reference TEXT;
ALTER TABLE agent_sessions ADD COLUMN agent_credential_provider TEXT;
ALTER TABLE agent_sessions ADD COLUMN agent_provider_mode TEXT;

CREATE INDEX idx_agent_sessions_credential_reference
  ON agent_sessions(agent_credential_reference)
  WHERE agent_credential_reference IS NOT NULL;

CREATE TABLE credential_limit_windows (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  credential_reference TEXT NOT NULL CHECK (length(credential_reference) BETWEEN 1 AND 160),
  window_type TEXT NOT NULL CHECK (length(window_type) BETWEEN 1 AND 128),
  credential_source TEXT NOT NULL CHECK (credential_source IN ('user', 'project', 'platform')),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
  provider_mode TEXT NOT NULL CHECK (length(provider_mode) BETWEEN 1 AND 80),
  agent_type TEXT CHECK (agent_type IS NULL OR length(agent_type) <= 80),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  chat_session_id TEXT,
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('allowed', 'allowed_warning', 'rejected', 'unknown')),
  last_event_level TEXT NOT NULL DEFAULT 'ok' CHECK (last_event_level IN ('ok', 'warning', 'critical', 'rejected')),
  utilization_percent REAL,
  limit_amount INTEGER,
  remaining_amount INTEGER,
  window_minutes INTEGER,
  resets_at INTEGER,
  observed_at INTEGER NOT NULL,
  freshness_ms INTEGER NOT NULL DEFAULT 0 CHECK (freshness_ms >= 0),
  last_event_delivery_key TEXT,
  duplicate_sample_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_sample_count >= 0),
  stale_sample_count INTEGER NOT NULL DEFAULT 0 CHECK (stale_sample_count >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, credential_reference, window_type)
);

CREATE INDEX idx_credential_limit_windows_project_session
  ON credential_limit_windows(project_id, workspace_id, agent_session_id);

CREATE INDEX idx_credential_limit_windows_observed_at
  ON credential_limit_windows(observed_at);
