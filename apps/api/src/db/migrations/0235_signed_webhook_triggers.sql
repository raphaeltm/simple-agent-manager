-- Signed webhook automations (Slack, and senders that HMAC the raw body the way GitHub does).
--
-- Additive only: webhook_trigger_configs hangs off triggers, an FK parent that must never be
-- recreated, and trigger_executions is not touched at all.
--
-- Existing rows: verification_scheme takes its default 'sam_bearer', which is exactly what every
-- existing automation is (SAM's own token on /api/webhooks/ingest), so nothing changes for them.
-- The other columns stay NULL, which the code reads as "no signing secret, no event-ID rule".
-- Signed automations still get a token_hash (the column is NOT NULL UNIQUE): it belongs to a
-- token that is never shown to anyone, and /api/webhooks/ingest refuses signed automations.
--
-- signing_secret_encrypted / signing_secret_iv: AES-GCM ciphertext and nonce of the provider's
-- signing secret (services/encryption.ts). SAM needs the secret itself to verify a signature, so
-- unlike the SAM token it cannot be stored as a hash. No endpoint returns it.
--
-- Waiting events reuse the trigger_executions queue columns from 0209 (status 'waiting',
-- queue_expires_at, rendered_prompt). webhook_deliveries.outcome has no CHECK constraint, so the
-- new outcomes ('queued', 'challenge', 'rejected', 'queue_full', 'dropped') need no table change.
ALTER TABLE webhook_trigger_configs ADD COLUMN verification_scheme TEXT NOT NULL DEFAULT 'sam_bearer';
ALTER TABLE webhook_trigger_configs ADD COLUMN signature_header TEXT;
ALTER TABLE webhook_trigger_configs ADD COLUMN event_id_source TEXT;
ALTER TABLE webhook_trigger_configs ADD COLUMN event_id_key TEXT;
ALTER TABLE webhook_trigger_configs ADD COLUMN signing_secret_encrypted TEXT;
ALTER TABLE webhook_trigger_configs ADD COLUMN signing_secret_iv TEXT;
ALTER TABLE webhook_trigger_configs ADD COLUMN signing_secret_set_at TEXT;
ALTER TABLE webhook_trigger_configs ADD COLUMN signing_secret_set_by TEXT;

-- A signed automation whose event ID arrives in a header also checks that it has not already
-- taken the same body under another ID (a header is not covered by the signature). This index
-- makes that check a lookup instead of a scan of the automation's call log.
CREATE INDEX idx_webhook_deliveries_trigger_fingerprint
  ON webhook_deliveries(trigger_id, request_fingerprint);

-- The shared trigger queue. Expiry runs on every cron tick and looked at every execution row;
-- the predicate here is written exactly as the expiry statement writes it, which is what lets
-- SQLite use the index.
CREATE INDEX idx_trigger_queue_expiry ON trigger_executions(queue_expires_at)
  WHERE status IN ('waiting','queued');

-- One automation's waiting line in order: counted on every accepted event, and read to find
-- the event at its head.
CREATE INDEX idx_trigger_queue_waiting ON trigger_executions(trigger_id, sequence_number)
  WHERE status = 'waiting';

-- The cron repair (repairWebhookQueueRecords) finds call records still marked 'queued' whose
-- run has started or been dropped. Only calls still marked queued are in this index, so the repair's
-- cost follows the live waiting lines, not the size of the call log. It is also the lookup when one run settles its call.
CREATE INDEX idx_webhook_deliveries_queued ON webhook_deliveries(execution_id)
  WHERE outcome = 'queued';

-- Webhook queue rows still holding the event's prompt: waiting events, plus any run whose
-- cleanup the cron repair still has to finish. Token webhook runs share event_type 'webhook'
-- but have no queue deadline, so they are not in it. Written exactly as the repair's predicate.
CREATE INDEX idx_trigger_queue_webhook_prompts ON trigger_executions(status)
  WHERE event_type = 'webhook' AND queue_expires_at IS NOT NULL AND rendered_prompt IS NOT NULL;
