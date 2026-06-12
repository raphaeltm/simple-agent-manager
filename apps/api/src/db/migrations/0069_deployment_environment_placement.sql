-- Deployment environment → node placement.
-- Links a deployment environment to its provisioned node and records
-- placement constraints (provider, location) per research doc 04.
-- One environment per node for MVP.

ALTER TABLE deployment_environments ADD COLUMN node_id TEXT REFERENCES nodes(id);
ALTER TABLE deployment_environments ADD COLUMN provider TEXT;
ALTER TABLE deployment_environments ADD COLUMN location TEXT;
