-- Per-project session index: let the project chat sidebar be served from D1
-- instead of a ProjectData DO round-trip on every load and every poll.
--
-- `session_summaries` (migration 0049) already indexes sessions for the
-- CROSS-project surfaces (/api/chats, /api/chats/recent). It could not serve the
-- per-project sidebar because three things the sidebar renders were missing:
-- the session creator (scope=my, isMine, the creator chip), the unresolved
-- attention marker (getAttentionState gives `needs_input` top precedence), and
-- chat_sessions.created_at. All three are added additively below.
--
-- The ProjectData DO stays authoritative; D1 remains an eventually-consistent
-- index. ADD COLUMN / CREATE TABLE only — `session_summaries` is an ON DELETE
-- CASCADE child of both `projects` and `users`, so recreating it would take its
-- rows (and, via projects, far more) with it. See .claude/rules/31.

ALTER TABLE session_summaries ADD COLUMN created_by_user_id TEXT;
ALTER TABLE session_summaries ADD COLUMN created_at INTEGER;

-- The most recent UNRESOLVED attention marker, serialized as the same summary
-- object getAttentionSummary() returns ({markerId, kind, createdAt, expiresAt,
-- reason, options}), or NULL when the session has none. Stored as one JSON blob
-- rather than six columns because the read path hands it straight back to the
-- client as an opaque `attention` object and never filters on its parts.
ALTER TABLE session_summaries ADD COLUMN attention_json TEXT;

-- When the DO last wrote this row. Distinct from `updated_at`, which mirrors the
-- SESSION's last activity: a row can be freshly synced yet describe a session
-- untouched for weeks, and the freshness gate has to tell those apart.
ALTER TABLE session_summaries ADD COLUMN synced_at INTEGER;

-- Per-project coverage record — the gate that decides whether D1 may answer.
--
-- Reading D1 is only safe when the index provably holds the SAME answer the DO
-- would give. `complete` records whether every session was indexed (the sync is
-- capped) and `synced_at` bounds staleness; together they are what the read path
-- checks before trusting the index. Missing, incomplete or stale coverage means
-- fall back to the DO, never guess.
--
-- `session_count` is diagnostic and drives the sync's own circuit breaker (once
-- a project is over the cap, `complete` can never return to 1 because sessions
-- are terminalized rather than deleted, so the sync stops mirroring). The read
-- path does NOT check it — `total` is always counted live from the rows.
CREATE TABLE session_index_coverage (
  project_id    TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  synced_at     INTEGER NOT NULL,
  session_count INTEGER NOT NULL DEFAULT 0,
  complete      INTEGER NOT NULL DEFAULT 0
);

-- Serves the sidebar's `WHERE project_id = ? [AND created_by_user_id = ?]
-- ORDER BY updated_at DESC`. The existing idx_session_summaries_project covers
-- the unfiltered case; this one keeps the scope=my variant off a scan.
CREATE INDEX idx_session_summaries_project_creator
  ON session_summaries(project_id, created_by_user_id, updated_at DESC);
