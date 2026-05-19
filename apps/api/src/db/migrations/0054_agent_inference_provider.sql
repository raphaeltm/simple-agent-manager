-- Add generic inference provider selection for agents that can use SAM-managed AI.
-- NULL means direct user/project credential behavior. 'sam' means explicit SAM platform provider.
ALTER TABLE agent_settings ADD COLUMN inference_provider TEXT;
