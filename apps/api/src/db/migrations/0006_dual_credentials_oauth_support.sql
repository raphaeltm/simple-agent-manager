-- Migration: 0006_dual_credentials_oauth_support
-- Feature: Agent OAuth & Subscription Authentication
-- Date: 2026-02-09
-- Description: Add support for dual credentials (API key + OAuth token) per agent

-- Phase 1: Add columns with defaults (non-breaking changes)
-- Add credential_kind to distinguish API keys from OAuth tokens
ALTER TABLE credentials
ADD COLUMN credential_kind TEXT NOT NULL DEFAULT 'api-key'
CHECK (credential_kind IN ('api-key', 'oauth-token'));

-- Add is_active to track which credential is currently in use
ALTER TABLE credentials
ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT 1;

-- Phase 2: Update indexes for new constraint model
-- Drop old unique index that prevents multiple credentials per agent
DROP INDEX IF EXISTS idx_credentials_user_type_agent;

-- Create new unique index allowing one of each kind per agent
-- This enforces: ONE credential per (user, agent, kind) combination
CREATE UNIQUE INDEX idx_credentials_user_agent_kind
ON credentials(user_id, agent_type, credential_kind)
WHERE credential_type = 'agent-api-key';

-- Index for efficient active credential queries
CREATE INDEX idx_credentials_active
ON credentials(user_id, agent_type, is_active)
WHERE credential_type = 'agent-api-key' AND is_active = 1;

-- Phase 3: Data migration for existing records
-- Mark all existing agent-api-key credentials as active API keys
UPDATE credentials
SET credential_kind = 'api-key',
    is_active = 1
WHERE credential_type = 'agent-api-key';

-- Ensure cloud-provider credentials remain unaffected
UPDATE credentials
SET is_active = 1
WHERE credential_type = 'cloud-provider';

-- Add comment for documentation
-- This migration enables storing both API keys and OAuth tokens for agents
-- while maintaining backward compatibility with existing credentials