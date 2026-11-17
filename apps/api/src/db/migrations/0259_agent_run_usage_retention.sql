-- Bound old run-usage telemetry independently of project deletion. The daily retention pass seeks
-- expired rows by updated_at and deletes one configured batch at a time.
CREATE INDEX IF NOT EXISTS idx_agent_run_usage_updated
  ON agent_run_usage (updated_at);
