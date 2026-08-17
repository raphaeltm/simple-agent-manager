-- Track deployment release status activity so scheduled reconciliation can
-- distinguish stale nonterminal releases from active apply/fetch work.
ALTER TABLE deployment_releases ADD COLUMN status_updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_deployment_releases_status_updated_at
  ON deployment_releases(status, status_updated_at);
