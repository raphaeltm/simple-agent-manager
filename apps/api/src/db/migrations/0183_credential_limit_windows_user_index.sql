-- Per-user credential usage reads (GET /api/credentials/limits) filter by
-- user_id + credential_source and order by observed_at. Every existing index on
-- credential_limit_windows leads with project_id or a bare timestamp, so that
-- read was a full table scan whose cost grew with platform-wide rows rather than
-- the caller's own credentials. Additive index only; no data change.
CREATE INDEX IF NOT EXISTS idx_credential_limit_windows_user_source_observed
  ON credential_limit_windows(user_id, credential_source, observed_at);
