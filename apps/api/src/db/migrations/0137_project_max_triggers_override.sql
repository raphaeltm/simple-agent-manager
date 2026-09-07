-- Per-project max triggers override.
-- NULL = use platform default (MAX_TRIGGERS_PER_PROJECT env var, default 20).
ALTER TABLE projects ADD COLUMN max_triggers INTEGER;