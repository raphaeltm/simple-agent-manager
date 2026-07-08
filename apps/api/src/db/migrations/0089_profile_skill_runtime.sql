-- Optional workspace runtime preference for profiles and skills.
-- NULL = automatic runtime resolution. Explicit values: vm, cf-container.
ALTER TABLE agent_profiles ADD COLUMN runtime TEXT;
ALTER TABLE skills ADD COLUMN runtime TEXT;
