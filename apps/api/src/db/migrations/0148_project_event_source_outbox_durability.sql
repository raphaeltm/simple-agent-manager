-- Bounded producer outbox durability fixes.
--
-- Keep this migration additive. ProjectData event storage is owned by a sibling
-- slice; this migration only extends the D1 producer ledger and task-row proof
-- needed to make source capture conditional on the winning terminal transition.

ALTER TABLE tasks ADD COLUMN terminal_transition_id TEXT;

ALTER TABLE project_event_source_outbox ADD COLUMN claim_token TEXT;
ALTER TABLE project_event_source_outbox ADD COLUMN claimed_at TEXT;
ALTER TABLE project_event_source_outbox ADD COLUMN terminalized_at TEXT;

CREATE INDEX idx_project_event_source_outbox_active_expiry
  ON project_event_source_outbox(state, expires_at, id);

CREATE INDEX idx_project_event_source_outbox_terminal_retention
  ON project_event_source_outbox(state, terminalized_at, id);
