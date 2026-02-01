-- MVP Hardening: Add shutdown_deadline for idle tracking
-- Migration: 0001_mvp_hardening.sql

-- Add shutdown_deadline column for predictable idle shutdown (US5)
ALTER TABLE workspaces ADD COLUMN shutdown_deadline TEXT;
