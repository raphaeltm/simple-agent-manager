-- Reply bodies live only in ProjectData chat messages. This ledger controls inbox visibility.
-- Additive: existing items have no replies and retain their behavior.
CREATE TABLE inbox_replies (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_ref TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  replied_at INTEGER NOT NULL,
  -- Only inbox_write respond/update writes this clock, never a human edit or session heartbeat.
  agent_acted_at INTEGER,
  PRIMARY KEY (project_id, item_ref, message_id)
);
CREATE INDEX idx_inbox_replies_latest ON inbox_replies(project_id, item_ref, replied_at DESC, message_id DESC);
