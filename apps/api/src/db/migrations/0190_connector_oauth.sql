CREATE TABLE connector_oauth_clients (
  id TEXT PRIMARY KEY NOT NULL,
  client_name TEXT NOT NULL,
  redirect_hosts TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at INTEGER,
  blocked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE connector_oauth_grants (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  oauth_grant_id TEXT,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX connector_oauth_grants_user ON connector_oauth_grants(user_id,created_at);
CREATE INDEX connector_oauth_grants_client ON connector_oauth_grants(client_id,revoked_at);
CREATE TABLE connector_oauth_refresh_uses (
  token_hash TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connector_oauth_grants(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX connector_oauth_refresh_uses_expiry ON connector_oauth_refresh_uses(expires_at);
CREATE INDEX connector_oauth_clients_expiry ON connector_oauth_clients(expires_at);
CREATE TABLE connector_oauth_registration_budget (
  id INTEGER PRIMARY KEY CHECK(id=1),
  window_start INTEGER NOT NULL,
  used INTEGER NOT NULL
);
