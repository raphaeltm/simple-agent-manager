-- Skills only override what they set: make skills.agent_type nullable.
--
-- SQLite cannot drop a NOT NULL constraint in place, and skills is an FK parent
-- (skill_runtime_env_vars / skill_runtime_files CASCADE, tasks / triggers /
-- workspace_resource_summaries SET NULL), so the table must not be recreated
-- (.claude/rules/31-migration-safety.md). Instead swap the column:
--   1. add a nullable column,
--   2. copy every existing value (no behaviour change for existing skills),
--   3. drop the old NOT NULL column (no index, FK, trigger or view uses it),
--   4. rename the new column into place.
-- DROP COLUMN has precedent in 0016 and 0078. No rows are deleted, so no FK
-- action fires. NULL now means "use the chosen profile's agent".
ALTER TABLE skills ADD COLUMN agent_type_nullable TEXT;

UPDATE skills SET agent_type_nullable = agent_type WHERE agent_type IS NOT NULL;

ALTER TABLE skills DROP COLUMN agent_type;

ALTER TABLE skills RENAME COLUMN agent_type_nullable TO agent_type;
