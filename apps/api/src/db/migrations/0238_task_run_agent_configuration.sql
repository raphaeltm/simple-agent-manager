-- The account a person chose for one run (services/run-agent-configuration.ts).
--
-- NULL means the run resolves its agent credential as before (profile pin, project, user
-- default, platform). Existing rows stay NULL and keep that behaviour; nothing is backfilled
-- because no run chose an account before this column existed.
ALTER TABLE tasks ADD COLUMN agent_configuration_id TEXT;
