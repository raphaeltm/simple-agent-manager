-- One short-lived authenticated claim per webhook; no plaintext credential storage.
ALTER TABLE webhook_trigger_configs ADD COLUMN claim_id TEXT;
ALTER TABLE webhook_trigger_configs ADD COLUMN claim_expires_at INTEGER;
ALTER TABLE webhook_trigger_configs ADD COLUMN claim_user_id TEXT;
ALTER TABLE webhook_trigger_configs ADD COLUMN claim_workspace_id TEXT;
ALTER TABLE webhook_trigger_configs ADD COLUMN claim_session_id TEXT;
CREATE UNIQUE INDEX idx_webhook_trigger_configs_claim_id ON webhook_trigger_configs(claim_id);
