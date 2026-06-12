-- Deployment environment → node placement.
-- Links a deployment environment to its provisioned node and records
-- placement constraints (provider, location) per research doc 04.
-- One environment per node for MVP.

ALTER TABLE deployment_environments ADD COLUMN node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL;
ALTER TABLE deployment_environments ADD COLUMN provider TEXT;
ALTER TABLE deployment_environments ADD COLUMN location TEXT;

-- Index for node → environment lookups (heartbeat, lifecycle).
CREATE INDEX IF NOT EXISTS idx_deployment_environments_node_id ON deployment_environments(node_id);
