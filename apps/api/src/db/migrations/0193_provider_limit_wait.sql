-- Recovery metadata only; existing tasks and all FK children are retained.
ALTER TABLE tasks ADD COLUMN provider_limit_wait_json TEXT;
CREATE INDEX IF NOT EXISTS idx_credential_limit_windows_credential_window_observed
  ON credential_limit_windows(credential_reference, window_type, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_credential_limit_windows_rejected_reset
  ON credential_limit_windows(status, resets_at, observed_at);
CREATE INDEX IF NOT EXISTS idx_tasks_provider_limit_credential
  ON tasks(json_extract(CASE WHEN json_valid(provider_limit_wait_json) THEN provider_limit_wait_json ELSE '{}' END, '$.credentialKey'), admission_state);
