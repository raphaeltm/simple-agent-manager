-- Additive rollout: older agents leave this null and remain deadline-only.
ALTER TABLE deployment_publish_jobs ADD COLUMN last_heartbeat_at TEXT;
