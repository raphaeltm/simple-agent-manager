-- Drop the dead opencode_provider_name column from agent_settings.
-- It was never read by the vm-agent and has no remaining consumers after the
-- OpenCode provider simplification (zen/go/custom). agent_settings has no
-- CASCADE children, so DROP COLUMN is safe (no data loss in dependent tables).
ALTER TABLE agent_settings DROP COLUMN opencode_provider_name;
