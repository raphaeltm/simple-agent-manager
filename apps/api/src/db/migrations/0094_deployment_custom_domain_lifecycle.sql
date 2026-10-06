-- Deployment custom-domain route lifecycle and route-only reconciliation.
-- Additive only: deployment_environment and deployment_custom_domains are live
-- parent tables, so this migration avoids table recreation and destructive DDL.

ALTER TABLE deployment_environments
  ADD COLUMN desired_routing_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deployment_environments
  ADD COLUMN observed_routing_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deployment_environments
  ADD COLUMN observed_routing_status TEXT;
ALTER TABLE deployment_environments
  ADD COLUMN observed_routing_error TEXT;
ALTER TABLE deployment_environments
  ADD COLUMN observed_routing_at TEXT;

CREATE INDEX idx_deployment_environments_routing_revision
  ON deployment_environments(desired_routing_revision, observed_routing_revision);

ALTER TABLE deployment_custom_domains
  ADD COLUMN verified_cname_target TEXT;
ALTER TABLE deployment_custom_domains
  ADD COLUMN desired_state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE deployment_custom_domains
  ADD COLUMN routing_status TEXT NOT NULL DEFAULT 'pending_dns';
ALTER TABLE deployment_custom_domains
  ADD COLUMN activation_routing_revision INTEGER;
ALTER TABLE deployment_custom_domains
  ADD COLUMN deactivation_routing_revision INTEGER;
ALTER TABLE deployment_custom_domains
  ADD COLUMN deleted_at TEXT;

UPDATE deployment_custom_domains
SET routing_status = CASE
  WHEN verification_status = 'verified' THEN 'dns_recheck_required'
  WHEN verification_status = 'failed' THEN 'failed'
  ELSE routing_status
END
WHERE routing_status = 'pending_dns';

CREATE INDEX idx_deployment_custom_domains_environment_state
  ON deployment_custom_domains(environment_id, desired_state, routing_status);
CREATE INDEX idx_deployment_custom_domains_activation_revision
  ON deployment_custom_domains(environment_id, activation_routing_revision);
CREATE INDEX idx_deployment_custom_domains_deactivation_revision
  ON deployment_custom_domains(environment_id, deactivation_routing_revision);

CREATE TABLE deployment_custom_domain_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES deployment_environments(id) ON DELETE CASCADE,
  custom_domain_id TEXT REFERENCES deployment_custom_domains(id) ON DELETE SET NULL,
  hostname TEXT NOT NULL,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  node_identifier TEXT,
  routing_revision INTEGER,
  event_type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_deployment_custom_domain_events_environment_created_at
  ON deployment_custom_domain_events(environment_id, created_at);
CREATE INDEX idx_deployment_custom_domain_events_domain_created_at
  ON deployment_custom_domain_events(custom_domain_id, created_at);
CREATE INDEX idx_deployment_custom_domain_events_node_created_at
  ON deployment_custom_domain_events(node_identifier, created_at);

-- Existing release/publish event tables use node_id as a NOT NULL CASCADE FK.
-- D1/SQLite cannot safely alter that FK in-place without table recreation, which
-- is forbidden by migration safety for live parent/child tables. Add immutable
-- node identifiers now so reads/writes can migrate to denormalized history and a
-- future archival path can sever the FK without losing display identity.
ALTER TABLE deployment_publish_job_events
  ADD COLUMN node_identifier TEXT;
ALTER TABLE deployment_release_events
  ADD COLUMN node_identifier TEXT;

UPDATE deployment_publish_job_events
SET node_identifier = node_id
WHERE node_identifier IS NULL;
UPDATE deployment_release_events
SET node_identifier = node_id
WHERE node_identifier IS NULL;
