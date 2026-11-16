-- Insights slice U (idea 01M7HTS38KX2G78JD0ESAGMKKH): measured token usage per run.
-- One row per (project, chat session, source, usage epoch, model, credential key).
--   Writers: recordHarnessRunUsage() (VM agent usage callback, apps/api/src/services/agent-run-usage.ts)
--            and recordProxyRunUsage() (AI proxy, same file).
--   Reads:   packages/operations/src/insights-run-usage.ts (run receipt, Accounts).
--
-- Counters are cumulative. Harness rows hold the VM agent's running totals for one usage epoch and
-- are upserted with a per-column MAX, so a repeated or reordered report never counts twice. AI proxy
-- rows are additive, one increment per measured upstream response. reasoning_tokens is NULL when
-- the harness does not report reasoning separately (it is then part of output_tokens).
--
-- credential_key is credentialLimitReferenceKey() of the server-attributed credential reference
-- (the key credential_limit_windows uses); '' means the run had no attributed credential. It is an
-- identifier, never a secret.
--
-- No foreign keys: rows are telemetry about a run and must never block or cascade a project,
-- workspace or session delete. Times are epoch milliseconds.
--
-- Additive only (rule 31): a new table and its indexes.
CREATE TABLE IF NOT EXISTS agent_run_usage (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL,
  chat_session_id TEXT NOT NULL,
  workspace_id TEXT,
  agent_session_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('harness', 'ai_proxy')),
  usage_epoch TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  credential_key TEXT NOT NULL DEFAULT '',
  credential_source TEXT,
  agent_type TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The upsert key, and the per-run read (project + chat session).
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_usage_key
  ON agent_run_usage (project_id, chat_session_id, source, usage_epoch, model, credential_key);
-- Usage per account over a window, always within one project (Accounts).
CREATE INDEX IF NOT EXISTS idx_agent_run_usage_project_credential
  ON agent_run_usage (project_id, credential_key, updated_at);
