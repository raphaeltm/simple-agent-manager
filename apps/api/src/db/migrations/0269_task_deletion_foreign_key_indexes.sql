-- A task delete checks each child FK for every deleted task, including SET NULL.
-- Project-leading history indexes cannot seek these task-only checks. Keep the
-- existing atomic deletion and FK actions; bound each lookup to matching rows.
CREATE INDEX idx_workspace_resource_chunks_task ON workspace_resource_chunks(task_id);
CREATE INDEX idx_workspace_resource_summaries_task ON workspace_resource_summaries(task_id);
CREATE INDEX idx_deployment_environments_created_by_task ON deployment_environments(created_by_task_id);
CREATE INDEX idx_debug_diagnoses_idea ON debug_diagnoses(idea_id);
CREATE INDEX idx_platform_feedback_triages_dispatched_task ON platform_feedback_triages(dispatched_task_id);
CREATE INDEX idx_platform_feedback_triages_claimed_task ON platform_feedback_triages(incident_claimed_by_task_id);
CREATE INDEX idx_platform_feedback_triages_resolved_task ON platform_feedback_triages(resolved_by_task_id);

-- Migrations 0202/0204 retain these leaf archives and their cascading FKs, but
-- move their secondary indexes to the canonical table. Every event deletion
-- must seek the archived reference too, even when no archive row matches.
CREATE INDEX idx_checkpoints_pre_workflow_initial_event
  ON task_submission_checkpoints_pre_workflow(initial_status_event_id);
CREATE INDEX idx_checkpoints_pre_email_initial_event
  ON task_submission_checkpoints_pre_email(initial_status_event_id);
