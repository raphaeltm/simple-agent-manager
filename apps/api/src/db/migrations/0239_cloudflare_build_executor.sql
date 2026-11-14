ALTER TABLE deployment_publish_jobs ADD COLUMN executor_instance_id TEXT;
ALTER TABLE deployment_publish_jobs ADD COLUMN executor_deadline_at TEXT;
ALTER TABLE deployment_publish_jobs ADD COLUMN executor_not_before TEXT;
CREATE INDEX idx_publish_job_executor_reservation ON deployment_publish_jobs(executor, executor_instance_id, project_id);
