-- Add volume-aware deployment placement flags.
-- Additive only: nodes and deployment_environments are FK parents.

ALTER TABLE nodes ADD COLUMN node_mode TEXT NOT NULL DEFAULT 'shared';

ALTER TABLE deployment_environments ADD COLUMN requires_volumes INTEGER NOT NULL DEFAULT 0;

