-- Only captures made with an exact source identity may authorize automatic physical cleanup.
-- Legacy snapshots remain recoverable, but never authorize automatic deletion.
ALTER TABLE session_snapshots ADD COLUMN cleanup_identity_json TEXT;
