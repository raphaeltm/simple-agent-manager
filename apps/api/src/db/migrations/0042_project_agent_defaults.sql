-- Per-project agent defaults (model + permission mode per agent type).
-- JSON: Record<AgentType, { model?: string | null, permissionMode?: string | null }>
-- Null/missing = fall through to user-level agent settings (existing behavior).
--
-- Part of Phase 1 of the multi-level configuration override system.
-- Resolution chain: task explicit > agent profile > project.agentDefaults[agentType] > user agent_settings > platform default

ALTER TABLE projects ADD COLUMN agent_defaults TEXT;
