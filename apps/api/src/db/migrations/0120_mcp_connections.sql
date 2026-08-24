-- Bring-your-own MCP servers.
--
-- Users paste an MCP endpoint (URL + optional bearer token) obtained from a connector
-- platform (Zapier MCP, executor.sh, Composio/Rube, Klavis) or an official single-service
-- MCP server. SAM injects it into agent sessions alongside its own `sam-mcp` endpoint.
--
-- Both `encrypted_url` and `encrypted_token` are AES-256-GCM ciphertext with their own IV.
-- The URL is encrypted because several providers issue pre-signed MCP URLs that embed the
-- credential in the path or query — the URL itself is a secret. `url_host` holds a
-- display-only `scheme://host` (never path or query) so the UI can show which provider a row
-- points at without the API ever returning a usable credential.
--
-- Additive only: creates one new table. No DROP, no ALTER of an existing table.

CREATE TABLE IF NOT EXISTS mcp_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- NULL = personal scope (applies to every session this user starts).
  -- Non-NULL = project scope (shared with project members, overrides personal by name).
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  encrypted_url TEXT NOT NULL,
  url_iv TEXT NOT NULL,
  url_host TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'bearer' CHECK (auth_type IN ('none', 'bearer')),
  encrypted_token TEXT,
  token_iv TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Name uniqueness is per-scope. Two partial indexes rather than one composite so that
-- personal rows (project_id IS NULL) collide only with the same user's personal rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_connections_project_name
ON mcp_connections(project_id, name)
WHERE project_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_connections_user_name
ON mcp_connections(user_id, name)
WHERE project_id IS NULL;

-- Resolution reads personal rows by user and project rows by project on the
-- agent-session start path; both need to be cheap.
CREATE INDEX IF NOT EXISTS idx_mcp_connections_user_id
ON mcp_connections(user_id);

CREATE INDEX IF NOT EXISTS idx_mcp_connections_project_id
ON mcp_connections(project_id);
