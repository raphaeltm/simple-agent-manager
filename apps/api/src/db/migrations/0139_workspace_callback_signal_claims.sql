-- Atomic, payload-free throttling for late callbacks from workspaces whose
-- runtime deletion is still unconfirmed. Expired rows are pruned in bounded
-- batches by the callback signal path.
CREATE TABLE workspace_callback_signal_claims (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  callback_kind TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, callback_kind)
);

CREATE INDEX idx_workspace_callback_signal_claims_expires_at
  ON workspace_callback_signal_claims(expires_at);
