-- Seekable exhaustion checks for producer-side event admission intents.
--
-- The exhaustion predicate compares two row columns, so the normal
-- (state, attempt_count, id) index cannot seek healthy rows out of the search.
-- Index the boolean expression directly and keep the processing lease deadline
-- in the key so abandoned final attempts are reclaimable without revoking live
-- final attempts before their lease expires.

CREATE INDEX idx_project_event_source_outbox_exhausted_ready
  ON project_event_source_outbox(state, (attempt_count >= max_attempts), processing_lease_expires_at, id);
