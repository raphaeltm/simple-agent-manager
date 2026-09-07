-- Credential limit eventing repair state.
--
-- Credential event emission now composes with the generic producer-side
-- `project_event_source_outbox` introduced by migration 0144. This migration
-- remains C2-owned and only adds credential-generation fencing plus bounded
-- window retention indexes for the credential observation state created by 0145.

ALTER TABLE agent_sessions
  ADD COLUMN agent_credential_generation INTEGER NOT NULL DEFAULT 0
  CHECK (agent_credential_generation >= 0);

CREATE INDEX idx_credential_limit_windows_project_updated
  ON credential_limit_windows(project_id, updated_at, credential_reference, window_type);

CREATE INDEX idx_credential_limit_windows_updated_global
  ON credential_limit_windows(updated_at, project_id, credential_reference, window_type);

CREATE INDEX idx_credential_limit_windows_project_delivery
  ON credential_limit_windows(project_id, last_event_delivery_key)
  WHERE last_event_delivery_key IS NOT NULL;

ALTER TABLE project_event_source_outbox ADD COLUMN credential_limit_window_type TEXT;
ALTER TABLE project_event_source_outbox ADD COLUMN credential_limit_observed_at INTEGER;

CREATE INDEX idx_project_event_source_outbox_credential_limit_active
  ON project_event_source_outbox(
    project_id,
    source,
    subject_id,
    credential_limit_window_type,
    state,
    credential_limit_observed_at,
    id
  )
  WHERE credential_limit_window_type IS NOT NULL
    AND credential_limit_observed_at IS NOT NULL;
