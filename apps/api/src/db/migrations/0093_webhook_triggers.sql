-- Generic project webhook triggers.
-- Additive only: triggers is an FK parent and must never be recreated.

ALTER TABLE triggers ADD COLUMN next_execution_sequence INTEGER NOT NULL DEFAULT 1;

UPDATE triggers
SET next_execution_sequence = COALESCE(
  (
    SELECT MAX(sequence_number) + 1
    FROM trigger_executions
    WHERE trigger_executions.trigger_id = triggers.id
  ),
  1
)
WHERE EXISTS (
  SELECT 1
  FROM trigger_executions
  WHERE trigger_executions.trigger_id = triggers.id
);

CREATE INDEX idx_tasks_trigger_execution_id
  ON tasks(trigger_execution_id)
  WHERE trigger_execution_id IS NOT NULL;

CREATE TABLE webhook_trigger_configs (
  trigger_id TEXT PRIMARY KEY REFERENCES triggers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  token_last_four TEXT NOT NULL,
  token_created_at TEXT NOT NULL,
  token_rotated_at TEXT,
  source_label TEXT,
  filter_mode TEXT NOT NULL DEFAULT 'all',
  filters_json TEXT NOT NULL DEFAULT '[]',
  included_headers_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_webhook_trigger_configs_token_hash
  ON webhook_trigger_configs(token_hash);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  idempotency_key_hash TEXT,
  request_fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  body_bytes INTEGER NOT NULL,
  processing_token TEXT,
  processing_heartbeat_at TEXT,
  execution_id TEXT REFERENCES trigger_executions(id) ON DELETE SET NULL,
  error_code TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_webhook_deliveries_trigger_received
  ON webhook_deliveries(trigger_id, received_at DESC, id DESC);

CREATE UNIQUE INDEX idx_webhook_deliveries_trigger_idempotency
  ON webhook_deliveries(trigger_id, idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;

CREATE INDEX idx_webhook_deliveries_expires
  ON webhook_deliveries(expires_at);

CREATE INDEX idx_webhook_deliveries_execution
  ON webhook_deliveries(execution_id);

CREATE INDEX idx_webhook_deliveries_processing_heartbeat
  ON webhook_deliveries(processing_heartbeat_at, id)
  WHERE outcome = 'processing' AND processing_token IS NOT NULL;
