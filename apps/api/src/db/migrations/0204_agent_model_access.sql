-- Agent model calls: which Cloudflare-hosted models agents may call with run_ai_model,
-- and a monthly spending limit per project.
--
-- Selection columns hold a JSON array of Workers AI model ids. NULL means "inherit the layer
-- below" (skill → profile → project → SAM defaults); '[]' means no models. Additive only.
ALTER TABLE projects ADD COLUMN agent_models_json TEXT;
ALTER TABLE projects ADD COLUMN agent_models_monthly_budget_cents INTEGER;
ALTER TABLE agent_profiles ADD COLUMN agent_models_json TEXT;
ALTER TABLE skills ADD COLUMN agent_models_json TEXT;

-- One row per project per UTC month. Amounts are integer micro-USD. reserved holds the
-- estimate of calls still running; a call reserves before it runs and settles afterwards.
CREATE TABLE IF NOT EXISTS agent_model_monthly_usage (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  reserved_micro_usd INTEGER NOT NULL DEFAULT 0,
  spent_micro_usd INTEGER NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, month)
);

-- Per-model breakdown of the same month, for the usage view.
CREATE TABLE IF NOT EXISTS agent_model_usage_by_model (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  model_id TEXT NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  spent_micro_usd INTEGER NOT NULL DEFAULT 0,
  last_called_at INTEGER,
  PRIMARY KEY (project_id, month, model_id)
);
