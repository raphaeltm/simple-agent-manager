-- Exact counting for watched incidents (follows 0264). Recurrences are deduplicated by
-- platform error id rather than by a last_seen_at watermark, so an error that commits late
-- with an older timestamp, or shares a millisecond with another, is still counted once.
--
-- watch_count_floor   last_seen_at when watching began: errors at or before it were already
--                     counted by the ordinary triage path
-- watch_counted_ids   JSON object: platform error id -> timestamp, for ids counted within the
--                     dedupe horizon (two triage windows); pruned on every write
--
-- Additive and nullable. Existing rows stay NULL; a NULL floor falls back to last_seen_at.
ALTER TABLE platform_feedback_triages ADD COLUMN watch_count_floor INTEGER;
ALTER TABLE platform_feedback_triages ADD COLUMN watch_counted_ids TEXT;
