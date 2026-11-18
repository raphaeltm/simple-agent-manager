-- A rejected usage report leaves one sticky disclosure row per project/chat.
-- No token counters, credential material, history deletion or retention change.
-- Like agent_run_usage, telemetry has no resource foreign keys.
-- Writer: recordHarnessRunUsage, marker BEFORE usage in the same atomic D1 batch.
-- Readers: shared run receipt and Insights Accounts operations.
CREATE TABLE IF NOT EXISTS agent_run_usage_admission_hits (
  project_id TEXT NOT NULL,
  chat_session_id TEXT NOT NULL,
  last_rejected_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, chat_session_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_agent_run_usage_hits_project_rejected
  ON agent_run_usage_admission_hits (project_id, last_rejected_at);
