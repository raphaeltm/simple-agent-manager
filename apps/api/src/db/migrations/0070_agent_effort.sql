-- Add normalized reasoning/thinking effort controls to agent profiles and skills.
-- Safe additive migration: no table recreation, no parent-table drops.

ALTER TABLE agent_profiles ADD COLUMN effort TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE skills ADD COLUMN effort TEXT;
