-- Bind destructive runtime operations to one exact node generation. Backfill
-- the currently represented generation so rollout does not strand live nodes.
ALTER TABLE nodes ADD COLUMN runtime_incarnation_id TEXT;

UPDATE nodes
   SET runtime_incarnation_id = lower(hex(randomblob(16)))
 WHERE runtime_incarnation_id IS NULL;
