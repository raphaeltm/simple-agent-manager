-- Per-step sleep/wake trace reported by the VM agent: which snapshot/restore phase ran, how
-- long each took, which phase failed and a bounded, redacted tail of its error output.
-- Additive child of the one-row-per-chat session_snapshots table; bounded to
-- operations.snapshotTracesPerSession rows per chat and operations.snapshotTraceRetentionDays.
-- Older VM agents send no trace fields and simply produce no rows.
CREATE TABLE session_snapshot_traces (
  id TEXT PRIMARY KEY NOT NULL,
  chat_session_id TEXT NOT NULL,
  project_id TEXT,
  workspace_id TEXT NOT NULL,
  node_id TEXT,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL,
  failed_phase TEXT,
  phases_json TEXT NOT NULL,
  error_tail TEXT,
  total_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_session_snapshot_traces_chat_created
  ON session_snapshot_traces(chat_session_id, created_at);
CREATE INDEX idx_session_snapshot_traces_created ON session_snapshot_traces(created_at);
