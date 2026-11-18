-- Wait steps use the existing mission step identity but never submit a task.
ALTER TABLE mission_steps ADD COLUMN wait_json TEXT;
ALTER TABLE mission_steps ADD COLUMN wait_registration_at INTEGER;
ALTER TABLE mission_steps ADD COLUMN wait_subscription_id TEXT;
ALTER TABLE mission_steps ADD COLUMN wait_listening_at INTEGER;
ALTER TABLE mission_steps ADD COLUMN wait_timeout_at INTEGER;
ALTER TABLE mission_steps ADD COLUMN wait_matched_event_json TEXT;
CREATE INDEX idx_mission_steps_wait_subscription ON mission_steps(wait_subscription_id);
