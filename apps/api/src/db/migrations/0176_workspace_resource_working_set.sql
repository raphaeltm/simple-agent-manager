ALTER TABLE workspace_resource_summaries
  ADD COLUMN memory_working_set_mean_bytes INTEGER;

ALTER TABLE workspace_resource_summaries
  ADD COLUMN memory_working_set_peak_bytes INTEGER;

ALTER TABLE workspace_resource_summaries
  ADD COLUMN memory_working_set_sample_count INTEGER NOT NULL DEFAULT 0;
