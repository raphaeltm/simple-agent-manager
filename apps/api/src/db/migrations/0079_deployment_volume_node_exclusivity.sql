-- Add volume-aware deployment placement flags.
-- Additive only: nodes and deployment_environments are FK parents.

ALTER TABLE nodes ADD COLUMN node_mode TEXT NOT NULL DEFAULT 'shared';

ALTER TABLE deployment_environments ADD COLUMN requires_volumes INTEGER NOT NULL DEFAULT 0;

-- Backfill existing provider-backed volume environments into the same
-- placement/readiness contract as newly-created volume environments.
UPDATE deployment_environments
SET requires_volumes = 1
WHERE id IN (
  SELECT DISTINCT environment_id
  FROM deployment_volumes
);

-- Any existing deployment node hosting a volume-backed environment must become
-- exclusive so future shared placement cannot co-tenant another environment on
-- a node that may need disruptive provider-volume handling.
UPDATE nodes
SET node_mode = 'exclusive'
WHERE node_role = 'deployment'
  AND id IN (
    SELECT DISTINCT node_id
    FROM deployment_environments
    WHERE requires_volumes = 1
      AND node_id IS NOT NULL
  );
