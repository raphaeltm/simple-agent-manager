-- Custom domains for deployment public routes (v1).
-- A user attaches their own subdomain (CNAME) to an existing public route of a
-- deployment environment. SAM verifies the hostname resolves to the route
-- target via Cloudflare DoH, then emits an additional static Caddy site block
-- (same hostPort as the parent public route) inside the signed ApplyPayload.
-- SAM does NOT own these DNS records — the user creates the CNAME themselves.

CREATE TABLE deployment_custom_domains (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES deployment_environments(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  port INTEGER NOT NULL,
  route_index INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'pending',
  verification_error TEXT,
  verified_at TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_deployment_custom_domains_hostname
  ON deployment_custom_domains(hostname);

CREATE INDEX idx_deployment_custom_domains_environment_id
  ON deployment_custom_domains(environment_id);
