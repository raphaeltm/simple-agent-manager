-- GitHub Trigger Configs: source-specific configuration for GitHub event triggers
CREATE TABLE IF NOT EXISTS github_trigger_configs (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,  -- 'issues', 'issue_comment', 'pull_request', 'push'
  filters_json TEXT NOT NULL DEFAULT '{}',  -- JSON: GitHubTriggerFilters
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_github_trigger_configs_trigger_id ON github_trigger_configs(trigger_id);
CREATE INDEX idx_github_trigger_configs_event_type ON github_trigger_configs(event_type);

-- GitHub Webhook Deliveries: dedup and audit trail for webhook events
CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  id TEXT PRIMARY KEY,  -- X-GitHub-Delivery header value
  event_type TEXT NOT NULL,
  action TEXT,
  installation_id TEXT,
  repository_full_name TEXT,
  sender_login TEXT,
  matched_trigger_id TEXT,  -- NULL if no trigger matched
  decision TEXT NOT NULL,  -- 'matched', 'no_match', 'filtered', 'duplicate', 'disabled', 'error'
  decision_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_github_webhook_deliveries_created ON github_webhook_deliveries(created_at);
CREATE INDEX idx_github_webhook_deliveries_installation ON github_webhook_deliveries(installation_id);
