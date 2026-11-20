-- WATCHING disposition for private incident triage (queue_state = 'watching').
--
-- queue_state is plain TEXT with no CHECK constraint (migration 0119), so the new value needs no
-- table change. These columns are additive and nullable; existing rows stay NULL and behave
-- exactly as before (no row is in the watching state until a triage run sets it).
--
-- watching_since           epoch ms of the latest watch decision; spike counting starts here
-- watch_reason             the triage agent's one-line reason (agent text, treat as untrusted)
-- watch_hourly_counts      JSON object: epoch hour (floor(ms / 3600000)) -> occurrences recorded
--                          while watching, pruned to the recent window on every write
-- watch_escalated_at       epoch ms a spike returned the signature to the dispatch queue
-- watch_escalation_reason  server-generated text naming the spike
ALTER TABLE platform_feedback_triages ADD COLUMN watching_since INTEGER;
ALTER TABLE platform_feedback_triages ADD COLUMN watch_reason TEXT;
ALTER TABLE platform_feedback_triages ADD COLUMN watch_hourly_counts TEXT;
ALTER TABLE platform_feedback_triages ADD COLUMN watch_escalated_at INTEGER;
ALTER TABLE platform_feedback_triages ADD COLUMN watch_escalation_reason TEXT;
