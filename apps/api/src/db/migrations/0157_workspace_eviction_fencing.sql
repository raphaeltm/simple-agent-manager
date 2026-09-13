-- Nullable for existing runtimes, whose first eviction carries no generation.
ALTER TABLE workspaces ADD COLUMN eviction_generation TEXT;
ALTER TABLE workspaces ADD COLUMN eviction_finalized_at TEXT;
