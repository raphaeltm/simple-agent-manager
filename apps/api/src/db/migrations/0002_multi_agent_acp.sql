-- Multi-Agent ACP: Extend credentials table for agent API keys
-- Migration: 0002_multi_agent_acp.sql

-- Add credential_type discriminator column
ALTER TABLE credentials ADD COLUMN credential_type TEXT NOT NULL DEFAULT 'cloud-provider';

-- Add agent_type column (NULL for cloud-provider credentials)
ALTER TABLE credentials ADD COLUMN agent_type TEXT;

-- Unique constraint: one credential per type per agent per user
CREATE UNIQUE INDEX idx_credentials_user_type_agent
  ON credentials(user_id, credential_type, agent_type);
