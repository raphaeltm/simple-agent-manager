-- Additive authority snapshots for capacity source generation and attachment identity.
--
-- These nullable fields let allocation guards compare the source row selected
-- during planning with the source row that still exists at the final D1 boundary.

ALTER TABLE nodes ADD COLUMN capacity_source_generation INTEGER;
ALTER TABLE nodes ADD COLUMN capacity_source_external_ref TEXT;

ALTER TABLE workspaces ADD COLUMN capacity_source_generation INTEGER;
ALTER TABLE workspaces ADD COLUMN capacity_source_external_ref TEXT;

ALTER TABLE tasks ADD COLUMN capacity_source_generation INTEGER;
ALTER TABLE tasks ADD COLUMN capacity_source_external_ref TEXT;
