-- Atomic per-workspace counters for workspace callback-token renewal
-- (POST /api/workspaces/:id/callback-token/renew).
--
-- A credential rotation endpoint needs a per-principal limit whose state cannot
-- lose increments under concurrent requests, which KV read-modify-write cannot
-- guarantee (.claude/rules/28). One row per workspace; a new window replaces the
-- counter in place, and deleting the workspace deletes its row.
--
-- Additive only: a new table. No DROP, no table rebuild.

CREATE TABLE workspace_callback_token_renewal_rate_limits (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  window_start INTEGER NOT NULL CHECK (window_start >= 0),
  count INTEGER NOT NULL CHECK (count >= 0)
);
