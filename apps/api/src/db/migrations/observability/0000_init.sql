-- Migration: Initial observability schema (spec 023)
-- Creates platform_errors table in the OBSERVABILITY_DATABASE

CREATE TABLE IF NOT EXISTS platform_errors (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  context TEXT,
  user_id TEXT,
  node_id TEXT,
  workspace_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer))
);

CREATE INDEX IF NOT EXISTS idx_platform_errors_timestamp ON platform_errors (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_platform_errors_source_timestamp ON platform_errors (source, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_platform_errors_level_timestamp ON platform_errors (level, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_platform_errors_created_at ON platform_errors (created_at);
